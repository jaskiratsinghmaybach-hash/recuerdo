import Resolver from "@forge/resolver";
import api, { route } from "@forge/api";
import { kvs } from "@forge/kvs";

const resolver = new Resolver();

// Cache key for a given issue's AI result. Namespaced with a prefix so it's
// easy to recognize/query if we ever need to list or clear cached entries.
function cacheKeyFor(issueKey) {
  return `ai-summary#${issueKey}`;
}

// Cache key for a given issue's source-selection preferences (which source
// categories the user has chosen to include). Per-issue, not global — set
// once via the filter panel, persists across reloads until changed.
function selectionKeyFor(issueKey) {
  return `source-selection#${issueKey}`;
}

// Every known source category and whether it's included by default. New
// source types (e.g. Confluence pages) get added here when they're built.
const DEFAULT_SELECTION = {
  description: true,
  comments: true,
};

// A lightweight, dependency-free fingerprint of everything that could
// change the AI's answer: the description text, status, resolution, and
// every comment's id + text + timestamp (covers new comments, edited
// comments, and deleted comments — not just "comment count"). Deliberately
// NOT using Node's crypto module: Forge's runtime has a long history of
// incomplete/unreliable crypto support (even the "native" Node runtime is
// a relatively recent fix), and this only needs to detect SOME difference
// reliably, not be cryptographically secure — a plain string comparison of
// all the inputs, reduced to a short non-crypto hash, is equally effective
// here with zero platform risk.
function computeContentFingerprint({
  description,
  status,
  resolution,
  comments,
}) {
  const parts = [
    description || "",
    status || "",
    resolution || "",
    ...comments.map((c) => `${c.id}|${c.created}|${c.text}`),
  ];
  const combined = parts.join("\u0001"); // unlikely separator, avoids accidental collisions between fields

  // Simple 32-bit rolling hash (not cryptographic — just needs to change
  // whenever the input does, which this does reliably for our purpose).
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    hash = (hash * 31 + combined.charCodeAt(i)) | 0; // |0 keeps it a 32-bit int, mirrors typical string-hash patterns
  }
  return hash.toString(36);
}

// Shallow comparison of two selection objects — true only if every known
// category matches. Used to decide whether a cached AI result was
// generated with the exact same source selection the user has right now.
function selectionsMatch(a, b) {
  if (!a || !b) return false;
  return Object.keys(DEFAULT_SELECTION).every(
    (key) => Boolean(a[key]) === Boolean(b[key]),
  );
}

resolver.define("setSourceSelection", async (req) => {
  const { issueKey, selection } = req.payload;

  if (!issueKey || !selection) {
    return { error: "Missing issueKey or selection" };
  }

  // Merge onto the defaults rather than trusting the payload wholesale, so
  // an older frontend that doesn't know about a newer source type can't
  // accidentally wipe its (future) default.
  const merged = { ...DEFAULT_SELECTION, ...selection };
  await kvs.set(selectionKeyFor(issueKey), merged);

  // Deliberately does NOT touch the cached AI result or trigger any
  // regeneration. Changing which sources are selected is now a pure
  // preference save — the summary currently shown keeps showing exactly as
  // is until the user explicitly clicks the refresh/apply button, which is
  // the only thing that ever triggers a new AI call.
  return { selection: merged };
});

resolver.define("getIssueContext", async (req) => {
  const { issueKey, forceRefresh } = req.payload;

  if (!issueKey) {
    return { error: "No issue key provided" };
  }

  try {
    const storedSelection = await kvs.get(selectionKeyFor(issueKey));
    const selection = { ...DEFAULT_SELECTION, ...(storedSelection || {}) };
    // Fetch the issue itself (status, summary, description, resolution)
    const issueRes = await api
      .asUser()
      .requestJira(
        route`/rest/api/3/issue/${issueKey}?fields=summary,status,resolution,description`,
      );
    const issue = await issueRes.json();

    // Fetch comments on the issue
    const commentsRes = await api
      .asUser()
      .requestJira(route`/rest/api/3/issue/${issueKey}/comment`);
    const commentsData = await commentsRes.json();

    const comments = (commentsData.comments || []).map((c) => ({
      id: c.id,
      author: c.author?.displayName || "Unknown",
      created: c.created,
      // body is Atlassian Document Format (ADF); extract plain text
      text: extractTextFromADF(c.body),
    }));

    const title = issue.fields?.summary;
    const status = issue.fields?.status?.name;
    const resolution = issue.fields?.resolution?.name || null;
    const description = extractTextFromADF(issue.fields?.description);

    // The AI result stays exactly as-is until the user explicitly clicks
    // the refresh/apply button — a plain panel load/remount NEVER triggers
    // a new AI call, regardless of the fingerprint. The fingerprint only
    // matters when forceRefresh is true: it decides whether that click
    // needs an actual new AI call, or can be answered instantly from cache
    // because nothing relevant has actually changed.
    const cacheKey = cacheKeyFor(issueKey);
    const currentFingerprint = computeContentFingerprint({
      description,
      status,
      resolution,
      comments,
    });
    const cached = await kvs.get(cacheKey);
    let aiResult;
    // The selection that actually produced aiResult — starts as a guess
    // but is corrected below once we know whether we're serving cached or
    // freshly-generated content. sources[] MUST be built from THIS, not
    // the user's live/unapplied selection, or a cached summary's citation
    // markers (numbered against an older source list) would point at the
    // wrong sources once the live selection has since been changed.
    let appliedSelection = selection;

    if (cached && !forceRefresh) {
      // Plain load: always show whatever's cached, never regenerate.
      aiResult = cached;
      appliedSelection = cached.selection || selection;
    } else if (
      cached &&
      forceRefresh &&
      cached.fingerprint === currentFingerprint &&
      selectionsMatch(cached.selection, selection)
    ) {
      // Refresh/apply was clicked, but neither the underlying Jira content
      // nor the selected sources have changed since we last generated —
      // skip the AI call entirely and return the cached result instantly.
      aiResult = cached;
      appliedSelection = cached.selection || selection;
    } else {
      // Either there's nothing cached yet, or something that matters
      // actually changed (content, or which sources are selected) — this
      // is the only branch that spends an AI call, using the user's
      // current (live) selection, since that's what's being applied now.
      const sourcesForGeneration = buildSourceList({
        description,
        comments,
        selection,
      });
      aiResult = await getAiSummary({
        issueKey,
        title,
        status,
        resolution,
        sources: sourcesForGeneration,
      });
      // Only cache a usable result — don't cache transient errors, so the
      // next attempt gets a real chance to succeed instead of being stuck
      // replaying a stored failure.
      if (aiResult.heading) {
        aiResult = { ...aiResult, fingerprint: currentFingerprint, selection };
        await kvs.set(cacheKey, aiResult);
      }
      appliedSelection = selection;
    }

    // NOTE: we deliberately do NOT build a full browsable URL here. Jira's
    // own "self" field on the issue/comment objects can be an internal
    // api.atlassian.com proxy URL rather than the real public site domain
    // (e.g. https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/...),
    // which produces a broken link if used directly. The frontend's
    // view.getContext() call already returns a reliable siteUrl for the
    // real domain, so each source only carries the relative piece
    // (focusedCommentId, if any) and the frontend builds the full URL.
    //
    // Built from appliedSelection (what actually produced aiResult), not
    // the live `selection` — see note above.
    const sources = buildSourceList({
      description,
      comments,
      selection: appliedSelection,
    });

    return {
      summary: title,
      status,
      resolution,
      comments,
      description,
      sources,
      selection, // the user's current (possibly unapplied) preference
      appliedSelection, // what the AI result currently shown was actually generated with
      aiHeading: aiResult.heading || null,
      aiBody: aiResult.body || [],
      aiCitations: aiResult.citations || [],
      aiError: aiResult.error || null,
    };
  } catch (err) {
    console.error("Error fetching issue context:", err);
    return { error: err.message };
  }
});

// Builds the unified, numbered list of citable sources. Index in this array
// (1-based) is exactly the citation marker number the AI will use, and what
// the frontend looks up when the user clicks a [n] marker.
//
// selection controls which categories are included at all:
// - A DESELECTED category (selection.description or selection.comments is
//   false) is skipped entirely — the user said not to use it, so it's
//   excluded from both the AI prompt and the citable sources list.
// - A SELECTED category that happens to have no real content (e.g. the
//   user wants the description included but the issue has none written)
//   still gets an explicit placeholder entry, so the AI is told plainly
//   that this source is empty rather than it silently going missing and
//   the AI guessing or staying silent about why.
//
// Each comment source carries commentId (Jira's real comment id). The
// frontend combines this with its own siteUrl (from view.getContext()) and
// the issue key to build the full "View in Jira" deep link
// (?focusedCommentId=<id>), opened in a new tab — same-tab navigation to a
// focusedCommentId is a known Jira Cloud limitation (JRACLOUD-77216).
function buildSourceList({ description, comments, selection }) {
  const sources = [];

  if (selection.description) {
    sources.push({
      type: "description",
      label: "Issue description",
      text: description || "(No description was written on this issue.)",
      commentId: null,
    });
  }

  if (selection.comments) {
    if (comments.length === 0) {
      sources.push({
        type: "comment",
        label: "Comments",
        text: "(No comments have been posted on this issue.)",
        commentId: null,
      });
    } else {
      comments.forEach((c, i) => {
        sources.push({
          type: "comment",
          label: `Comment ${i + 1} — ${c.author}`,
          text: c.text,
          commentId: c.id || null,
        });
      });
    }
  }

  return sources;
}

// Calls the Lambda proxy (recuerdo-bedrock-proxy), which forwards the prompt
// to whichever AI backend is currently wired up behind it (Bedrock, Gemini,
// or Anthropic — the resolver doesn't need to know or care which).
//
// Contract with the Lambda proxy:
//   Request:  POST, header "x-recuerdo-secret": <shared secret>,
//             JSON body { prompt: string }
//   Response: JSON body { summary: string, citations: [{marker, reason}] }
//             on success, or { error: string } on failure.
async function getAiSummary({ issueKey, title, status, resolution, sources }) {
  const proxyUrl = process.env.LAMBDA_PROXY_URL;
  const proxySecret = process.env.LAMBDA_PROXY_SECRET;

  if (!proxyUrl || !proxySecret) {
    console.error("LAMBDA_PROXY_URL or LAMBDA_PROXY_SECRET is not configured");
    return { error: "AI backend is not configured" };
  }

  if (!sources || sources.length === 0) {
    // Nothing to summarize — don't waste a call on an issue with no content.
    return { summary: null };
  }

  const prompt = buildPrompt({ issueKey, title, status, resolution, sources });

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

    return {
      heading: data.heading || null,
      body: data.body || [],
      citations: data.citations || [],
    };
  } catch (err) {
    console.error("Error calling Lambda proxy:", err);
    return { error: "Could not reach AI backend" };
  }
}

// Builds the prompt sent to the AI model. Asks for STRUCTURED JSON output:
// a short heading, one or more body blocks (plain paragraphs, or a bulleted
// list when that's genuinely clearer — the AI's own judgment call, not
// forced every time), with [n] citation markers inline in the text, plus a
// citations array explaining why each marker was cited. The source list is
// numbered exactly as buildSourceList() numbered it, so markers map
// directly to sources[] on the frontend with no fuzzy matching required.
function buildPrompt({ issueKey, title, status, resolution, sources }) {
  const sourceBlock = sources
    .map((s, i) => `[${i + 1}] ${s.label}:\n${s.text}`)
    .join("\n\n");

  return [
    `You are summarizing why a Jira issue was closed or resolved, for a teammate who is about to re-investigate it.`,
    `Issue: ${issueKey} — "${title}"`,
    `Status: ${status}${resolution ? `, Resolution: ${resolution}` : ""}`,
    ``,
    `Here are the available sources, numbered:`,
    ``,
    sourceBlock,
    ``,
    `Respond with ONLY a JSON object (no markdown, no code fences) in this exact shape:`,
    `{`,
    `  "heading": "A short, bold-worthy title for the decision, a few words (e.g. 'TTL/refresh mismatch').",`,
    `  "body": [`,
    `    { "type": "paragraph", "text": "Prose text with inline citation markers like [1] or [2] placed right after each claim they support." },`,
    `    { "type": "bullets", "items": ["Point one [3]", "Point two [4]"] }`,
    `  ],`,
    `  "citations": [`,
    `    { "marker": 1, "reason": "A SHORT phrase, under 12 words, on why source [1] supports that claim — not a full sentence." }`,
    `  ]`,
    `}`,
    ``,
    `Rules:`,
    `- Use a SINGLE "paragraph" block for simple, short explanations (most cases).`,
    `- Use a "bullets" block ONLY when the issue involved several distinct comments, sources, or a genuinely multi-step chain of events that is clearer as separate points. Don't force bullets when one or two sentences would do.`,
    `- You may mix one paragraph block followed by one bullets block (e.g. a one-line lead-in, then supporting points) if that reads best — but never more than 2 blocks total.`,
    `- Keep the total word count across all blocks under about 60 words. Brevity matters more than completeness.`,
    `- Keep each citation "reason" to at most 12 words.`,
    `- Only cite source numbers that actually exist in the list above.`,
    `- Every citation marker used anywhere in "body" must have a matching entry in "citations".`,
    `- If the sources don't contain a clear decision or reason, say so plainly in one paragraph block instead of guessing, and return an empty "citations" array.`,
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
