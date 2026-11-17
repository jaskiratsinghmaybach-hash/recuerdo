import Resolver from "@forge/resolver";
import api, { route } from "@forge/api";

const resolver = new Resolver();

resolver.define("getIssueContext", async (req) => {
  const { issueKey } = req.payload;

  if (!issueKey) {
    return { error: "No issue key provided" };
  }

  try {
    // Fetch the issue itself (status, summary)
    const issueRes = await api
      .asUser()
      .requestJira(
        route`/rest/api/3/issue/${issueKey}?fields=summary,status,resolution`,
      );
    const issue = await issueRes.json();

    // Fetch comments on the issue
    const commentsRes = await api
      .asUser()
      .requestJira(route`/rest/api/3/issue/${issueKey}/comment`);
    const commentsData = await commentsRes.json();

    const comments = (commentsData.comments || []).map((c) => ({
      author: c.author?.displayName || "Unknown",
      created: c.created,
      // body is Atlassian Document Format (ADF); extract plain text
      text: extractTextFromADF(c.body),
    }));

    const title = issue.fields?.summary;
    const status = issue.fields?.status?.name;
    const resolution = issue.fields?.resolution?.name || null;

    // Ask the AI backend (via the Lambda proxy) for a cited summary of why
    // this issue was closed/resolved. We always return the raw issue data
    // even if the AI call fails, so the panel can still show something.
    const aiResult = await getAiSummary({
      issueKey,
      title,
      status,
      resolution,
      comments,
    });

    return {
      summary: title,
      status,
      resolution,
      comments,
      aiSummary: aiResult.summary || null,
      aiError: aiResult.error || null,
    };
  } catch (err) {
    console.error("Error fetching issue context:", err);
    return { error: err.message };
  }
});

// Calls the Lambda proxy (recuerdo-bedrock-proxy), which forwards the prompt
// to whichever AI backend is currently wired up behind it (Bedrock, Gemini,
// or Anthropic — the resolver doesn't need to know or care which).
//
// Contract with the Lambda proxy:
//   Request:  POST, header "x-recuerdo-secret": <shared secret>,
//             JSON body { prompt: string }
//   Response: JSON body { summary: string } on success,
//             or { error: string } on failure.
//
// NOTE: if your actual deployed Lambda proxy uses a different request/response
// shape (e.g. { messages: [...] } instead of { prompt }, or a different
// response field), this function is the only place that needs to change.
async function getAiSummary({ issueKey, title, status, resolution, comments }) {
  const proxyUrl = process.env.LAMBDA_PROXY_URL;
  const proxySecret = process.env.LAMBDA_PROXY_SECRET;

  if (!proxyUrl || !proxySecret) {
    console.error("LAMBDA_PROXY_URL or LAMBDA_PROXY_SECRET is not configured");
    return { error: "AI backend is not configured" };
  }

  if (!comments || comments.length === 0) {
    // Nothing to summarize — don't waste a call on an issue with no discussion.
    return { summary: null };
  }

  const prompt = buildPrompt({ issueKey, title, status, resolution, comments });

  try {
    const res = await api.fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-recuerdo-secret": proxySecret,
      },
      body: JSON.stringify({ prompt }),
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      console.error(`Lambda proxy returned ${res.status}: ${bodyText}`);
      return { error: `AI backend error (status ${res.status})` };
    }

    const data = await res.json();

    if (data.error) {
      console.error("Lambda proxy reported an error:", data.error);
      return { error: data.error };
    }

    return { summary: data.summary || null };
  } catch (err) {
    console.error("Error calling Lambda proxy:", err);
    return { error: "Could not reach AI backend" };
  }
}

// Builds the prompt sent to the AI model. Keeps the ask narrow and grounded:
// summarize the resolution decision, cite which comment(s) it came from, and
// say so explicitly if no real decision is evident in the comments.
function buildPrompt({ issueKey, title, status, resolution, comments }) {
  const commentBlock = comments
    .map((c, i) => `[Comment ${i + 1}] ${c.author} (${c.created}):\n${c.text}`)
    .join("\n\n");

  return [
    `You are summarizing why a Jira issue was closed or resolved, for a teammate who is about to re-investigate it.`,
    `Issue: ${issueKey} — "${title}"`,
    `Status: ${status}${resolution ? `, Resolution: ${resolution}` : ""}`,
    ``,
    `Here are the comments on this issue, in order:`,
    ``,
    commentBlock,
    ``,
    `Write a short (2-4 sentence) summary of the actual decision that was made and why, based only on what is said in these comments. Reference which comment number(s) your summary is based on, like "(see Comment 2)". If the comments don't contain a clear decision or reason, say so plainly instead of guessing.`,
  ].join("\n");
}

// Minimal ADF-to-text extractor — walks the document tree and pulls text nodes
function extractTextFromADF(adf) {
  if (!adf || !adf.content) return "";
  let text = "";
  const walk = (node) => {
    if (node.type === "text") {
      text += node.text;
    }
    if (node.content) {
      node.content.forEach(walk);
    }
    if (node.type === "paragraph") {
      text += "\n";
    }
  };
  adf.content.forEach(walk);
  return text.trim();
}

export const handler = resolver.getDefinitions();
