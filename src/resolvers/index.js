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

  // Changing which sources feed the AI makes the previously cached result
  // stale — clear it so the next load regenerates with the new selection,
  // without the user needing to separately click Refresh too.
  await kvs.delete(cacheKeyFor(issueKey));

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

    // NOTE: we deliberately do NOT build a full browsable URL here. Jira's
    // own "self" field on the issue/comment objects can be an internal
    // api.atlassian.com proxy URL rather than the real public site domain
    // (e.g. https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/...),
    // which produces a broken link if used directly. The frontend's
    // view.getContext() call already returns a reliable siteUrl for the
    // real domain, so each source only carries the relative piece
    // (focusedCommentId, if any) and the frontend builds the full URL.
    const sources = buildSourceList({ description, comments, selection });

    // Once the AI has generated a result for this issue, it should STAY as
    // is until the user explicitly clicks Refresh — not regenerate on every
    // panel load/remount. So: check the cache first, and only call the AI
    // when there's no cached result yet, or the user explicitly asked for
    // a refresh.
    const cacheKey = cacheKeyFor(issueKey);
    let aiResult;

    if (!forceRefresh) {
      const cached = await kvs.get(cacheKey);
      if (cached) {
        aiResult = cached;
      }
    }

    if (!aiResult) {
      aiResult = await getAiSummary({
        issueKey,
        title,
        status,
        resolution,
        sources,
      });
      // Only cache a usable result — don't cache transient errors, so the
      // next load (or Refresh) gets a real chance to succeed instead of
      // being stuck replaying a stored failure.
      if (aiResult.heading) {
        await kvs.set(cacheKey, aiResult);
      }
    }

    return {
      summary: title,
      status,
      resolution,
      comments,
      description,
      sources,
      selection,
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
