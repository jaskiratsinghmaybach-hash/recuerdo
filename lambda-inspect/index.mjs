// recuerdo-proxy — Pure AWS Bedrock Mantle Lambda Function URL handler
//
// 100% AWS-NATIVE BACKEND CHAIN:
//   1. AWS Bedrock Mantle (deepseek.v3-v1:0) in us-east-1       [Primary — uses AWS credits]
//   2. AWS Bedrock Mantle (qwen.qwen3-235b-a22b-2507-v1:0) in us-east-1 [Secondary — uses AWS credits]
//
// Zero external dependencies (uses native Node 22+ crypto and fetch).
// No Google Cloud dependencies.

import crypto from "node:crypto";

const MANTLE_HOST = "bedrock-mantle.us-east-1.api.aws";
const MANTLE_PATH = "/v1/chat/completions";
const MANTLE_REGION = "us-east-1";
const MANTLE_SERVICE = "bedrock-mantle";
const MANTLE_MODELS = [
    "deepseek.v3-v1:0",
    "qwen.qwen3-235b-a22b-2507-v1:0",
];
const MANTLE_TIMEOUT_MS = 20000;

const SUMMARY_SYSTEM_INSTRUCTION = `You must respond ONLY with a valid JSON object matching this exact schema (no markdown fences, no extra text):
{
  "effectivelyResolved": true,
  "sectionTitle": "Why this was resolved",
  "heading": "short heading, a few words",
  "body": [
    { "type": "paragraph", "text": "paragraph text with inline [n] citation markers" },
    { "type": "bullets", "items": ["bullet item 1 with [n]", "bullet item 2"] }
  ],
  "citations": [
    { "marker": 1, "reason": "short explanation of why source 1 supports this claim" }
  ]
}
Rules:
- "effectivelyResolved": true if a fix/solution was implemented or confirmed; false if active, blocked, or in progress.
- "sectionTitle": e.g. "Why this was resolved" if resolved; "Where this stands" if open/investigating; "Current investigation status" if ambiguous.
- "body" must contain one or more blocks, choosing "paragraph" or "bullets" depending on complexity.
- Every [n] marker used in "body" must have a matching entry in "citations".`;

const CHAT_SYSTEM_INSTRUCTION = `You are Recuerdo AI, an intelligent institutional-memory assistant for this Jira issue.
You must respond ONLY with a valid JSON object matching this exact schema (no markdown fences, no extra text):
{
  "reply": "Clear, grounded answer to the user's question with inline [n] citation markers where relevant.",
  "citations": [
    { "marker": 1, "reason": "short phrase explaining why source 1 supports this statement" }
  ]
}
Rules:
- ONLY answer questions concerning this specific Jira issue, its sources, and its team context.
- If the question is completely off-topic (e.g. weather, general jokes, unrelated tasks), politely decline and redirect the user back to this issue.
- Ground all facts in the provided sources. Do not invent facts or people.
- Use [n] citation markers whenever quoting or referencing facts from the numbered sources.`;

function hmac(key, data) {
    return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data) {
    return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function signMantleRequest(bodyStr) {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const sessionToken = process.env.AWS_SESSION_TOKEN;

    if (!accessKeyId || !secretAccessKey) {
        throw new Error("AWS credentials not found in Lambda environment");
    }

    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(bodyStr);

    let canonicalHeaders =
        `content-type:application/json\n` +
        `host:${MANTLE_HOST}\n` +
        `x-amz-date:${amzDate}\n`;
    let signedHeaders = "content-type;host;x-amz-date";

    if (sessionToken) {
        canonicalHeaders += `x-amz-security-token:${sessionToken}\n`;
        signedHeaders += ";x-amz-security-token";
    }

    const canonicalRequest = [
        "POST",
        MANTLE_PATH,
        "",
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join("\n");

    const credentialScope = `${dateStamp}/${MANTLE_REGION}/${MANTLE_SERVICE}/aws4_request`;
    const stringToSign = [
        "AWS4-HMAC-SHA256",
        amzDate,
        credentialScope,
        sha256Hex(canonicalRequest),
    ].join("\n");

    const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, MANTLE_REGION);
    const kService = hmac(kRegion, MANTLE_SERVICE);
    const kSigning = hmac(kService, "aws4_request");
    const signature = crypto
        .createHmac("sha256", kSigning)
        .update(stringToSign, "utf8")
        .digest("hex");

    const headers = {
        "Content-Type": "application/json",
        Host: MANTLE_HOST,
        "X-Amz-Date": amzDate,
        Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };

    if (sessionToken) {
        headers["X-Amz-Security-Token"] = sessionToken;
    }

    return headers;
}

async function callBedrockMantle(model, prompt, systemInstruction = SUMMARY_SYSTEM_INSTRUCTION) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MANTLE_TIMEOUT_MS);

    const payload = JSON.stringify({
        model,
        messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: 2048,
    });

    try {
        const headers = signMantleRequest(payload);
        const res = await fetch(`https://${MANTLE_HOST}${MANTLE_PATH}`, {
            method: "POST",
            headers,
            body: payload,
            signal: controller.signal,
        });

        const raw = await res.text();
        if (!res.ok) {
            throw new Error(`Mantle ${model} HTTP ${res.status}: ${raw.slice(0, 250)}`);
        }

        const data = JSON.parse(raw);
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) {
            throw new Error(`Mantle ${model} returned empty content`);
        }

        return content
            .trim()
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/, "");
    } finally {
        clearTimeout(timer);
    }
}

async function generateStructuredSummary(prompt, systemInstruction = SUMMARY_SYSTEM_INSTRUCTION) {
    let lastError = null;
    for (const model of MANTLE_MODELS) {
        try {
            const text = await callBedrockMantle(model, prompt, systemInstruction);
            console.log(`Served via AWS Bedrock Mantle (${model})`);
            return text;
        } catch (err) {
            console.warn(`AWS Mantle (${model}) failed, trying next:`, err.message);
            lastError = err;
        }
    }
    throw new Error(`All AWS Bedrock Mantle models failed: ${lastError?.message || "Unknown error"}`);
}

export const handler = async (event) => {
    const SHARED_SECRET = process.env.SHARED_SECRET;
    const headers = event.headers || {};
    const providedSecret =
        headers["x-recuerdo-secret"] || headers["X-Recuerdo-Secret"];

    if (!providedSecret || providedSecret !== SHARED_SECRET) {
        return {
            statusCode: 401,
            body: JSON.stringify({ error: "Unauthorized" }),
        };
    }

    let body;
    try {
        body = JSON.parse(event.body || "{}");
    } catch {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Invalid JSON body" }),
        };
    }

    const { prompt, mode = "summary" } = body;
    if (!prompt) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Missing "prompt" in request body' }),
        };
    }

    try {
        const systemInstruction =
            mode === "chat"
                ? CHAT_SYSTEM_INSTRUCTION
                : SUMMARY_SYSTEM_INSTRUCTION;
        const rawText = await generateStructuredSummary(
            prompt,
            systemInstruction,
        );
        const parsed = JSON.parse(rawText);

        if (mode === "chat") {
            if (typeof parsed.reply !== "string") {
                return {
                    statusCode: 502,
                    body: JSON.stringify({
                        error: "Invalid AI chat response structure",
                    }),
                };
            }
            return {
                statusCode: 200,
                body: JSON.stringify({
                    reply: parsed.reply,
                    citations: Array.isArray(parsed.citations)
                        ? parsed.citations
                        : [],
                }),
            };
        }

        // Summary mode
        if (
            typeof parsed.heading !== "string" ||
            !parsed.heading.trim() ||
            !Array.isArray(parsed.body)
        ) {
            return {
                statusCode: 502,
                body: JSON.stringify({ error: "Invalid AI JSON structure" }),
            };
        }

        const cleanedBody = parsed.body
            .map((block) => {
                if (!block || typeof block !== "object") return null;
                if (
                    block.type === "bullets" &&
                    Array.isArray(block.items) &&
                    block.items.length > 0
                ) {
                    const items = block.items.filter(
                        (item) => typeof item === "string" && item.trim(),
                    );
                    if (items.length > 0) {
                        return { type: "bullets", items };
                    }
                }
                if (
                    block.type === "paragraph" &&
                    typeof block.text === "string" &&
                    block.text.trim()
                ) {
                    return { type: "paragraph", text: block.text };
                }
                return null;
            })
            .filter(Boolean);

        if (cleanedBody.length === 0) {
            return {
                statusCode: 502,
                body: JSON.stringify({
                    error: "AI output had no usable content blocks",
                }),
            };
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                effectivelyResolved:
                    typeof parsed.effectivelyResolved === "boolean"
                        ? parsed.effectivelyResolved
                        : true,
                sectionTitle:
                    typeof parsed.sectionTitle === "string" &&
                    parsed.sectionTitle.trim()
                        ? parsed.sectionTitle.trim()
                        : parsed.effectivelyResolved === false
                          ? "Where this stands"
                          : "Why this was resolved",
                heading: parsed.heading,
                body: cleanedBody,
                citations: Array.isArray(parsed.citations)
                    ? parsed.citations
                    : [],
            }),
        };
    } catch (err) {
        console.error("AWS Bedrock Mantle execution error:", err);
        return {
            statusCode: 502,
            body: JSON.stringify({
                error: "AI call failed",
                details: err.message,
            }),
        };
    }
};
