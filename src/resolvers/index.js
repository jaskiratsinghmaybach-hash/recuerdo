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

// Cache key for a given issue's shared conversation history.
// Shared across all team members who open this issue (shared institutional memory).
function chatKeyFor(issueKey) {
  return `chat-history#${issueKey}`;
}

// Every known source category and whether it's included by default.
const DEFAULT_SELECTION = {
  description: true,
  comments: true,
  attachments: true,
  history: true,
  confluence: true,
};

// Maximum characters allowed per comment in the AI prompt. Large logs or
// stack traces pasted into comments are truncated to preserve token budget.
const MAX_COMMENT_CHARS = 1200;

// Maximum characters we read from a text-based attachment file. Enough for
// a full stack trace, config file, or short crash log — but we cap it so
// a 10 MB log file doesn't blow the prompt token budget.
const MAX_ATTACHMENT_CHARS = 2000;

// MIME types and file extensions we consider "plain text" and therefore
// safe to fetch and read as UTF-8 from the Jira attachment download URL.
// Images, PDFs, and binary blobs are excluded — the AI can't read those.
const TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/xml",
  "text/x-log",
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/x-sh",
  "application/javascript",
  "application/typescript",
]);

// File extensions treated as readable text even if the MIME type is generic
// (e.g. "application/octet-stream" for .log files uploaded from Windows).
const TEXT_EXTENSIONS = new Set([
  "txt", "log", "md", "markdown", "csv", "json", "yaml", "yml",
  "xml", "html", "htm", "js", "ts", "jsx", "tsx", "py", "rs",
  "go", "java", "kt", "rb", "php", "sh", "bash", "zsh", "fish",
  "sql", "toml", "ini", "cfg", "conf", "env", "properties",
]);

// Returns true for file types our AI backend can actually read.
// Images, PDFs, videos, and binary blobs return false — the AI is text-only.
function isTextReadable(mimeType, filename) {
  if (mimeType && TEXT_MIME_TYPES.has(mimeType.toLowerCase().split(";")[0].trim())) {
    return true;
  }
  if (filename) {
    const ext = filename.split(".").pop()?.toLowerCase();
    if (ext && TEXT_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

// Returns true for image MIME types (jpg, png, gif, webp, svg, etc.)
// We call these out specifically in the prompt so the AI knows a visual
// artifact exists, even though it cannot see the pixels.
function isImageFile(mimeType, filename) {
  if (mimeType && mimeType.toLowerCase().startsWith("image/")) return true;
  const imageExts = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "tiff", "heic"]);
  if (filename) {
    const ext = filename.split(".").pop()?.toLowerCase();
    if (ext && imageExts.has(ext)) return true;
  }
  return false;
}

// Fetches the raw content of a Jira attachment by its numeric ID.
// Uses the Jira REST API v3 attachment content endpoint, which returns the
// raw binary (or text) of the file — we decode it as UTF-8 text.
// On any error (network, permission, too-large file), returns null so the
// caller can fall back to the metadata-only label gracefully.
async function fetchAttachmentText(attachmentId, maxChars) {
  try {
    // The Jira REST API endpoint for downloading raw attachment content.
    // Note: ?redirect=false tells Jira to give us the content directly,
    // not issue a redirect to a CDN — which Forge's sandbox can't follow.
    const res = await api
      .asUser()
      .requestJira(route`/rest/api/3/attachment/content/${attachmentId}?redirect=false`);

    if (!res.ok) {
      console.warn(`Attachment ${attachmentId} content fetch returned ${res.status}`);
      return null;
    }

    // Read the response body as text (UTF-8). We don't parse it further —
    // log files, JSON, Markdown, source code — all are valuable as raw text.
    const rawText = await res.text();
    if (!rawText || !rawText.trim()) return null;

    // Truncate to our budget. We append a note so the AI knows it was cut.
    return truncateText(rawText.trim(), maxChars);
  } catch (err) {
    console.warn(`Could not fetch attachment ${attachmentId} content:`, err.message);
    return null;
  }
}

// Maximum total comments included directly in the AI prompt. For large threads
// (e.g. 20-100+ comments), we preserve the first 5 (initial context/triage)
// and the last 15 (resolution/verification), inserting a brief summary note
// for omitted intermediate comments.
const MAX_COMMENTS_IN_PROMPT = 20;
const HEAD_COMMENTS_COUNT = 5;
const TAIL_COMMENTS_COUNT = 15;

function truncateText(text, maxChars) {
  if (!text || text.length <= maxChars) return text || "";
  const remaining = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n[...truncated ${remaining} characters of logs/stacktrace...]`;
}

// Walks Atlassian Document Format (ADF) nodes and extracts any external or card URLs
function extractUrlsFromADF(adf) {
  if (!adf || !adf.content) return [];
  const urls = [];
  const walk = (node) => {
    if (!node) return;
    if ((node.type === "inlineCard" || node.type === "blockCard") && node.attrs?.url) {
      urls.push(node.attrs.url);
    }
    if (node.marks && Array.isArray(node.marks)) {
      node.marks.forEach((m) => {
        if (m.type === "link" && m.attrs?.href) {
          urls.push(m.attrs.href);
        }
      });
    }
    if (node.content && Array.isArray(node.content)) {
      node.content.forEach(walk);
    }
  };
  walk(adf);
  return urls;
}

// Extracts Confluence Page ID from common Confluence Cloud URL structures,
// including standard space URLs, viewpage action URLs, and Confluence short/tiny URLs (/wiki/x/...)
function extractConfluencePageId(url) {
  if (!url || typeof url !== "string") return null;
  // Pattern 1: /wiki/spaces/KEY/pages/1234567/Page+Title
  const m1 = url.match(/\/wiki\/spaces\/[^\/]+\/pages\/(\d+)/i);
  if (m1) return m1[1];
  // Pattern 2: /wiki/pages/viewpage.action?pageId=1234567
  const m2 = url.match(/[?&]pageId=(\d+)/i);
  if (m2) return m2[1];
  // Pattern 3: Confluence Tiny URL (/wiki/x/<shortKey>) - base64 little-endian encoded 32-bit ID
  const m3 = url.match(/\/wiki\/x\/([A-Za-z0-9_-]+)/i);
  if (m3) {
    try {
      const b64 = m3[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "===".slice((b64.length + 3) % 4);
      const buf = Buffer.from(padded, "base64");
      let id = 0;
      for (let i = 0; i < buf.length; i++) {
        id += buf[i] * Math.pow(256, i);
      }
      if (id > 0) return String(id);
    } catch (e) {
      // ignore decode error and return null
    }
  }
  return null;
}

// Fetches a Confluence page summary with graceful fallback if inaccessible
async function fetchConfluencePageSummary(pageId, fullUrl) {
  try {
    const res = await api
      .asUser()
      .requestConfluence(route`/wiki/api/v2/pages/${pageId}?body-format=storage`);

    if (res.ok) {
      const data = await res.json();
      const title = data.title || "Linked Confluence Page";
      const rawBody = data.body?.storage?.value || "";
      const plainText = rawBody
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        pageId,
        title,
        url: fullUrl,
        text: truncateText(plainText || "(Page has no text content)", 1000),
      };
    }

    // Fallback to REST API v1 if v2 isn't available
    const v1Res = await api
      .asUser()
      .requestConfluence(route`/wiki/rest/api/content/${pageId}?expand=body.view`);
    if (v1Res.ok) {
      const v1Data = await v1Res.json();
      const title = v1Data.title || "Linked Confluence Page";
      const rawBody = v1Data.body?.view?.value || "";
      const plainText = rawBody
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        pageId,
        title,
        url: fullUrl,
        text: truncateText(plainText || "(Page has no text content)", 1000),
      };
    }

    return {
      pageId,
      title: "Linked Confluence Page",
      url: fullUrl,
      text: `(Linked Confluence page could not be accessed. Status: ${res.status})`,
    };
  } catch (err) {
    console.warn(`Could not access Confluence page ${pageId}:`, err.message);
    return {
      pageId,
      title: "Linked Confluence Page",
      url: fullUrl,
      text: `(Linked Confluence page could not be accessed: ${err.message})`,
    };
  }
}

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
  attachments = [],
  transitions = [],
  confluencePages = [],
}) {
  const parts = [
    description || "",
    status || "",
    resolution || "",
    ...comments.map((c) => `${c.id}|${c.created}|${c.text}`),
    ...attachments.map((a) => `${a.id}|${a.filename}|${a.size}|${a.content?.slice(0, 50) ?? ""}`),
    ...transitions.map((t) => `${t.field}|${t.from}|${t.to}|${t.created}`),
    ...confluencePages.map(
      (cp) => `${cp.pageId}|${cp.title}|${cp.text.slice(0, 50)}`,
    ),
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

// Helper to fetch all raw Jira issue details, comments, attachments, changelog, and Confluence pages
async function fetchIssueData(issueKey) {
  const issueRes = await api
    .asUser()
    .requestJira(
      route`/rest/api/3/issue/${issueKey}?fields=summary,status,resolution,assignee,reporter,description,attachment&expand=changelog`,
    );
  const issue = await issueRes.json();

  const commentsRes = await api
    .asUser()
    .requestJira(route`/rest/api/3/issue/${issueKey}/comment`);
  const commentsData = await commentsRes.json();

  const comments = (commentsData.comments || []).map((c) => ({
    id: c.id,
    author: c.author?.displayName || "Unknown",
    created: c.created,
    text: extractTextFromADF(c.body),
  }));

  const rawAttachments = issue.fields?.attachment || [];
  const baseAttachments = rawAttachments.map((a) => ({
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    author: a.author?.displayName || "Unknown",
    created: a.created,
    content: null,
    canReadContent: isTextReadable(a.mimeType, a.filename),
    isImage: isImageFile(a.mimeType, a.filename),
  }));

  const attachments = await Promise.all(
    baseAttachments.map(async (a) => {
      if (!a.canReadContent) return a;
      const content = await fetchAttachmentText(a.id, MAX_ATTACHMENT_CHARS);
      return { ...a, content };
    }),
  );

  const rawHistories = issue.changelog?.histories || [];
  const transitions = [];
  rawHistories.forEach((h) => {
    const author = h.author?.displayName || "Unknown";
    const created = h.created;
    (h.items || []).forEach((item) => {
      if (item.field === "status" || item.field === "resolution") {
        transitions.push({
          field: item.field,
          from: item.fromString || "(none)",
          to: item.toString || "(none)",
          author,
          created,
        });
      }
    });
  });

  const title = issue.fields?.summary || "";
  const status = issue.fields?.status?.name || "";
  const resolution = issue.fields?.resolution?.name || null;
  const assignee = issue.fields?.assignee?.displayName || "Unassigned";
  const reporter = issue.fields?.reporter?.displayName || "Unknown";
  const description = extractTextFromADF(issue.fields?.description);

  const rawConfluenceUrls = [
    ...extractUrlsFromADF(issue.fields?.description),
    ...(commentsData.comments || []).flatMap((c) =>
      extractUrlsFromADF(c.body),
    ),
  ];
  const wikiRegex =
    /https:\/\/[a-zA-Z0-9-]+\.atlassian\.net\/wiki\/[^\s"')\]]+/g;
  const allText = `${description} ${comments.map((c) => c.text).join(" ")}`;
  let textMatch;
  while ((textMatch = wikiRegex.exec(allText)) !== null) {
    rawConfluenceUrls.push(textMatch[0]);
  }

  const uniqueConfluenceMap = new Map();
  for (const url of rawConfluenceUrls) {
    const pageId = extractConfluencePageId(url);
    if (pageId && !uniqueConfluenceMap.has(pageId)) {
      uniqueConfluenceMap.set(pageId, url);
    }
  }

  const confluencePages = await Promise.all(
    Array.from(uniqueConfluenceMap.entries())
      .slice(0, 3)
      .map(([pageId, url]) => fetchConfluencePageSummary(pageId, url)),
  );

  return {
    issue,
    title,
    status,
    resolution,
    assignee,
    reporter,
    description,
    comments,
    attachments,
    transitions,
    confluencePages,
  };
}

resolver.define("getIssueContext", async (req) => {
  const { issueKey, forceRefresh } = req.payload;

  if (!issueKey) {
    return { error: "No issue key provided" };
  }

  try {
    const storedSelection = await kvs.get(selectionKeyFor(issueKey));
    const selection = { ...DEFAULT_SELECTION, ...(storedSelection || {}) };

    const issueData = await fetchIssueData(issueKey);
    const {
      title,
      status,
      resolution,
      assignee,
      reporter,
      description,
      comments,
      attachments,
      transitions,
      confluencePages,
    } = issueData;

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
      attachments,
      transitions,
      confluencePages,
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
      
      const hasAnyContent =
        Boolean(description) ||
        comments.length > 0 ||
        attachments.length > 0 ||
        transitions.length > 0 ||
        confluencePages.length > 0;

      if (!hasAnyContent) {
        aiResult = {
          heading: null,
          body: [],
          citations: [],
          effectivelyResolved: true,
          sectionTitle: "Why this was resolved",
        };
      } else {
        const sourcesForGeneration = buildSourceList({
          description,
          comments,
          attachments,
          transitions,
          confluencePages,
          selection,
        });
        aiResult = await getAiSummary({
          issueKey,
          title,
          status,
          resolution,
          assignee,
          reporter,
          sources: sourcesForGeneration,
        });
        // Only cache a usable result — don't cache transient errors, so the
        // next attempt gets a real chance to succeed instead of being stuck
        // replaying a stored failure.
        if (aiResult.heading) {
          aiResult = { ...aiResult, fingerprint: currentFingerprint, selection };
          await kvs.set(cacheKey, aiResult);
        }
      }
      appliedSelection = selection;
    }

    // Built from appliedSelection (what actually produced aiResult), not
    // the live `selection` — see note above.
    const sources = buildSourceList({
      description,
      comments,
      attachments,
      transitions,
      confluencePages,
      selection: appliedSelection,
    });

    return {
      summary: title,
      status,
      resolution,
      assignee,
      reporter,
      comments,
      description,
      sources,
      selection, // the user's current (possibly unapplied) preference
      appliedSelection, // what the AI result currently shown was actually generated with
      aiHeading: aiResult.heading || null,
      aiBody: aiResult.body || [],
      aiCitations: aiResult.citations || [],
      aiError: aiResult.error || null,
      effectivelyResolved: aiResult.effectivelyResolved ?? true,
      sectionTitle:
        aiResult.sectionTitle ||
        (aiResult.effectivelyResolved === false
          ? "Where this stands"
          : "Why this was resolved"),
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
function buildSourceList({
  description,
  comments,
  attachments = [],
  transitions = [],
  confluencePages = [],
  selection,
}) {
  const sources = [];

  if (selection.description) {
    sources.push({
      type: "description",
      label: "Issue description",
      text: description || "(No description was written on this issue.)",
      commentId: null,
      attachmentId: null,
      confluenceUrl: null,
    });
  }

  // Confluence documentation is placed prominently right after description
  // so the AI gives equal first-class weight to official post-mortems and specs.
  if (selection.confluence && confluencePages.length > 0) {
    confluencePages.forEach((cp, i) => {
      sources.push({
        type: "confluence",
        label: `Confluence Doc ${i + 1} — ${cp.title}`,
        text: `Document "${cp.title}":\n${cp.text}`,
        commentId: null,
        attachmentId: null,
        confluenceUrl: cp.url,
      });
    });
  }

  if (selection.comments) {
    if (comments.length === 0) {
      sources.push({
        type: "comment",
        label: "Comments",
        text: "(No comments have been posted on this issue.)",
        commentId: null,
        attachmentId: null,
        confluenceUrl: null,
      });
    } else if (comments.length <= MAX_COMMENTS_IN_PROMPT) {
      comments.forEach((c, i) => {
        sources.push({
          type: "comment",
          label: `Comment ${i + 1} — ${c.author}`,
          text: truncateText(c.text, MAX_COMMENT_CHARS),
          commentId: c.id || null,
          attachmentId: null,
          confluenceUrl: null,
        });
      });
    } else {
      // Long comment thread (e.g. 20+ comments):
      // Keep first HEAD_COMMENTS_COUNT comments (initial triage / discovery)
      for (let i = 0; i < HEAD_COMMENTS_COUNT; i++) {
        const c = comments[i];
        sources.push({
          type: "comment",
          label: `Comment ${i + 1} — ${c.author}`,
          text: truncateText(c.text, MAX_COMMENT_CHARS),
          commentId: c.id || null,
          attachmentId: null,
          confluenceUrl: null,
        });
      }

      // Add middle-omitted source note
      const omittedCount =
        comments.length - (HEAD_COMMENTS_COUNT + TAIL_COMMENTS_COUNT);
      if (omittedCount > 0) {
        sources.push({
          type: "comment",
          label: `Comments ${HEAD_COMMENTS_COUNT + 1} to ${HEAD_COMMENTS_COUNT + omittedCount} (Omitted)`,
          text: `(${omittedCount} intermediate discussion comments omitted for brevity. Focus on initial triage and final resolution.)`,
          commentId: null,
          attachmentId: null,
          confluenceUrl: null,
        });
      }

      // Keep last TAIL_COMMENTS_COUNT comments (decision, fix confirmation, deploy notes)
      const tailStartIndex = Math.max(
        HEAD_COMMENTS_COUNT,
        comments.length - TAIL_COMMENTS_COUNT,
      );
      for (let i = tailStartIndex; i < comments.length; i++) {
        const c = comments[i];
        sources.push({
          type: "comment",
          label: `Comment ${i + 1} — ${c.author}`,
          text: truncateText(c.text, MAX_COMMENT_CHARS),
          commentId: c.id || null,
          attachmentId: null,
          confluenceUrl: null,
        });
      }
    }
  }

  if (selection.attachments) {
    if (attachments.length === 0) {
      sources.push({
        type: "attachment",
        label: "Attachments",
        text: "(No attachments were uploaded to this issue.)",
        commentId: null,
        attachmentId: null,
        confluenceUrl: null,
      });
    } else {
      attachments.forEach((a, i) => {
        const sizeKb = Math.round((a.size || 0) / 1024);
        // Build the text shown to the AI and in the citation modal.
        // Three cases:
        //   1. Text-readable file with content fetched → show actual file content.
        //   2. Image file → note that it's a visual artifact (AI can't see pixels).
        //   3. Binary/PDF/unknown → metadata-only label (filename, size, type).
        let text;
        if (a.canReadContent && a.content) {
          // The AI gets the real file contents — most useful case.
          text = `File "${a.filename}" (${a.mimeType || "text"}, ${sizeKb} KB) uploaded by ${a.author} on ${a.created?.slice(0, 10)}.\n\nContents:\n${a.content}`;
        } else if (a.isImage) {
          // Image: flag it so the AI knows a visual was attached, even though
          // it cannot see the image itself. It may still reference the filename
          // as evidence (e.g. "a screenshot named error-state.png was attached").
          text = `Image file "${a.filename}" (${a.mimeType || "image"}, ${sizeKb} KB) uploaded by ${a.author} on ${a.created?.slice(0, 10)}. Note: image content cannot be read — only the filename and metadata are available.`;
        } else {
          // Binary/PDF/other: metadata-only, same as before.
          text = `File "${a.filename}" (${a.mimeType || "unknown"}, ${sizeKb} KB) uploaded by ${a.author} on ${a.created?.slice(0, 10)}.`;
        }
        sources.push({
          type: "attachment",
          label: `Attachment ${i + 1} — ${a.filename}`,
          text,
          commentId: null,
          attachmentId: a.id || null,
          confluenceUrl: null,
        });
      });
    }
  }

  if (selection.history) {
    if (transitions.length === 0) {
      sources.push({
        type: "history",
        label: "Status changelog",
        text: "(No status or resolution transitions recorded.)",
        commentId: null,
        attachmentId: null,
        confluenceUrl: null,
      });
    } else {
      transitions.forEach((t, i) => {
        sources.push({
          type: "history",
          label: `Transition ${i + 1} — ${t.field} (${t.author})`,
          text: `On ${t.created?.slice(0, 16).replace("T", " ")}, ${t.author} updated ${t.field} from "${t.from}" to "${t.to}".`,
          commentId: null,
          attachmentId: null,
          confluenceUrl: null,
        });
      });
    }
  }

  return sources;
}

// Calls the Lambda proxy (recuerdo-bedrock-proxy), which forwards the prompt
// to AWS Bedrock Mantle (DeepSeek V3 primary, Qwen fallback).
async function getAiSummary({
  issueKey,
  title,
  status,
  resolution,
  assignee,
  reporter,
  sources,
}) {
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

  const prompt = buildPrompt({
    issueKey,
    title,
    status,
    resolution,
    assignee,
    reporter,
    sources,
  });

  try {
    const res = await api.fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-recuerdo-secret": proxySecret,
      },
      body: JSON.stringify({ mode: "summary", prompt }),
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
      effectivelyResolved: data.effectivelyResolved ?? true,
      sectionTitle:
        data.sectionTitle ||
        (data.effectivelyResolved === false
          ? "Where this stands"
          : "Why this was resolved"),
      heading: data.heading || null,
      body: data.body || [],
      citations: data.citations || [],
    };
  } catch (err) {
    console.error("Error calling Lambda proxy:", err);
    return { error: "Could not reach AI backend" };
  }
}

// Builds the prompt sent to the AI model for the primary issue summary.
// Evaluates resolution status, team participants, and synthesizes across all sources.
function buildPrompt({
  issueKey,
  title,
  status,
  resolution,
  assignee,
  reporter,
  sources,
}) {
  const sourceBlock = sources
    .map((s, i) => `[${i + 1}] ${s.label}:\n${s.text}`)
    .join("\n\n");

  return [
    `You are Recuerdo AI, an institutional-memory decision intelligence engine analyzing a Jira issue.`,
    `Issue: ${issueKey} — "${title}"`,
    `Ticket Status: ${status}${resolution ? `, Resolution: ${resolution}` : ""}`,
    `Assignee: ${assignee || "Unassigned"} | Reporter: ${reporter || "Unknown"}`,
    ``,
    `Here are all available sources, numbered:`,
    ``,
    sourceBlock,
    ``,
    `First, assess whether the underlying technical problem or task is EFFECTIVELY RESOLVED based on the sources (do not blindly trust the ticket status — verify whether a solution, fix, or decision was actually achieved).`,
    ``,
    `Respond with ONLY a JSON object (no markdown, no code fences) in this exact shape:`,
    `{`,
    `  "effectivelyResolved": true,`,
    `  "sectionTitle": "Why this was resolved",`,
    `  "heading": "A short, bold-worthy title for the decision/status, a few words (e.g. 'Connection pool timeout misconfigured').",`,
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
    `- "effectivelyResolved": true if a fix, resolution, or final plan was confirmed; false if active, blocked, in-progress, or unresolved.`,
    `- "sectionTitle": If resolved: "Why this was resolved". If unresolved/active/blocked: "Where this stands". If ambiguous/inconclusive: "Current investigation status".`,
    `- If resolved: summarize why and how it was resolved, citing root-cause and fix.`,
    `- If unresolved: summarize the current state of investigation — what was tried, what was ruled out, who last acted, what the blocker is, and recommended next action (grounded strictly in participants from ticket fields, comments, Confluence, or attachments).`,
    `- GROUNDED TEAM ROLES: People's names and roles can appear across ANY source — the issue description, Confluence documentation, comments, ticket assignee/reporter, or attachments. Attribute actions only to real participants from the sources — never invent fictional people.`,
    `- EQUAL PRIORITY ACROSS ALL SOURCES: You MUST treat all source categories (Confluence documentation, Code/Log attachments, Comments, Description, Status history) with EQUAL weight. Do not favor comments over documentation or attachments over Confluence. Cross-cite across multiple different source types!`,
    `- Use a SINGLE "paragraph" block for simple, short explanations (most cases).`,
    `- Use a "bullets" block ONLY when the issue involved several distinct comments, sources, or a genuinely multi-step chain of events that is clearer as separate points. Don't force bullets when one or two sentences would do.`,
    `- You may mix one paragraph block followed by one bullets block if that reads best — but never more than 2 blocks total.`,
    `- Keep the total word count across all blocks under about 90 words.`,
    `- Keep each citation "reason" to at most 12 words.`,
    `- Only cite source numbers that actually exist in the list above.`,
    `- Every citation marker used anywhere in "body" must have a matching entry in "citations".`,
    `- If the sources don't contain a clear decision or reason, say so plainly in one paragraph block instead of guessing, and return an empty "citations" array.`,
  ].join("\n");
}

// Builds the prompt sent to the AI model for follow-up chat Q&A.
function buildChatPrompt({
  issueKey,
  title,
  status,
  resolution,
  assignee,
  reporter,
  sources,
  history,
  question,
}) {
  const sourceBlock = sources
    .map((s, i) => `[${i + 1}] ${s.label}:\n${s.text}`)
    .join("\n\n");

  const recentHistory = history
    .slice(-6)
    .map((m) => `${m.authorName || (m.isUser ? "Teammate" : "Recuerdo")}: ${m.text}`)
    .join("\n");

  return [
    `You are Recuerdo AI, an institutional-memory decision assistant answering follow-up questions about Jira issue ${issueKey} ("${title}").`,
    `Status: ${status}${resolution ? `, Resolution: ${resolution}` : ""}`,
    `Assignee: ${assignee} | Reporter: ${reporter}`,
    ``,
    `Here are all available sources for this issue, numbered:`,
    sourceBlock,
    ``,
    recentHistory ? `Recent conversation:\n${recentHistory}\n` : ``,
    `Teammate's question: "${question}"`,
    ``,
    `Respond with ONLY a JSON object (no markdown fences):`,
    `{`,
    `  "reply": "Your direct, clear answer citing relevant sources using inline [n] citation markers where helpful.",`,
    `  "citations": [`,
    `    { "marker": 1, "reason": "short explanation under 12 words" }`,
    `  ]`,
    `}`,
    ``,
    `Rules:`,
    `- ONLY answer questions concerning this specific Jira issue, its sources, and its team context.`,
    `- If the question is completely off-topic (e.g. weather, general jokes, unrelated tasks), politely decline and state you can only answer questions about this issue.`,
    `- Ground all facts strictly in the numbered sources. People's names and roles can appear in description, Confluence, comments, ticket assignee/reporter, or attachments. Attribute actions only to real participants from the sources — never invent fictional people.`,
    `- Use [n] citation markers whenever quoting or referencing facts from the sources.`,
    `- Keep answers under 85 words. Be direct, helpful, and concise.`,
  ].join("\n");
}

// --------------------------------------------------------------------------
// Chat Resolver Definitions (Shared Institutional Memory)
// --------------------------------------------------------------------------

resolver.define("getChatHistory", async (req) => {
  const { issueKey } = req.payload;
  if (!issueKey) return { messages: [] };
  const history = await kvs.get(chatKeyFor(issueKey));
  return { messages: Array.isArray(history) ? history : [] };
});

resolver.define("clearChatHistory", async (req) => {
  const { issueKey } = req.payload;
  if (!issueKey) return { success: false, messages: [] };
  await kvs.set(chatKeyFor(issueKey), []);
  return { success: true, messages: [] };
});

resolver.define("sendChatMessage", async (req) => {
  const { issueKey, question, userName } = req.payload;
  if (!issueKey || !question || !question.trim()) {
    return { error: "Missing issueKey or question" };
  }

  try {
    const issueData = await fetchIssueData(issueKey);
    const {
      title,
      status,
      resolution,
      assignee,
      reporter,
      description,
      comments,
      attachments,
      transitions,
      confluencePages,
    } = issueData;

    const sources = buildSourceList({
      description,
      comments,
      attachments,
      transitions,
      confluencePages,
      selection: DEFAULT_SELECTION,
    });

    const existingHistory = (await kvs.get(chatKeyFor(issueKey))) || [];

    const chatPrompt = buildChatPrompt({
      issueKey,
      title,
      status,
      resolution,
      assignee,
      reporter,
      sources,
      history: existingHistory,
      question: question.trim(),
    });

    const proxyUrl = process.env.LAMBDA_PROXY_URL;
    const proxySecret = process.env.LAMBDA_PROXY_SECRET;

    const res = await api.fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-recuerdo-secret": proxySecret,
      },
      body: JSON.stringify({ mode: "chat", prompt: chatPrompt }),
    });

    if (!res.ok) {
      return { error: `AI chat service error (status ${res.status})` };
    }

    const data = await res.json();
    if (data.error) {
      return { error: data.error };
    }

    const now = new Date().toISOString();
    const userMsg = {
      id: `u-${Date.now()}`,
      authorName: userName || "You",
      isUser: true,
      text: question.trim(),
      timestamp: now,
    };

    const aiMsg = {
      id: `ai-${Date.now() + 1}`,
      authorName: "Recuerdo",
      isUser: false,
      text: data.reply || "No response generated.",
      citations: Array.isArray(data.citations) ? data.citations : [],
      timestamp: new Date().toISOString(),
    };

    const updated = [...existingHistory, userMsg, aiMsg];
    await kvs.set(chatKeyFor(issueKey), updated);

    return { messages: updated };
  } catch (err) {
    console.error("Error in sendChatMessage:", err);
    return { error: err.message };
  }
});

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
