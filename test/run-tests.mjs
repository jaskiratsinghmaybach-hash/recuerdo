// test/run-tests.mjs
// Repeatable automated unit test suite for Recuerdo Forge app logic.

import assert from "node:assert/strict";

// --- 1. Pure functions from src/resolvers/index.js ---

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
    ...attachments.map((a) => `${a.id}|${a.filename}|${a.size}`),
    ...transitions.map((t) => `${t.field}|${t.from}|${t.to}|${t.created}`),
    ...confluencePages.map(
      (cp) => `${cp.pageId}|${cp.title}|${cp.text.slice(0, 50)}`,
    ),
  ];
  const combined = parts.join("\u0001");
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    hash = (hash * 31 + combined.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

const MAX_COMMENT_CHARS = 1200;
const MAX_COMMENTS_IN_PROMPT = 20;
const HEAD_COMMENTS_COUNT = 5;
const TAIL_COMMENTS_COUNT = 15;

function truncateText(text, maxChars) {
  if (!text || text.length <= maxChars) return text || "";
  const remaining = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n[...truncated ${remaining} characters of logs/stacktrace...]`;
}

function extractConfluencePageId(url) {
  if (!url || typeof url !== "string") return null;
  const m1 = url.match(/\/wiki\/spaces\/[^\/]+\/pages\/(\d+)/i);
  if (m1) return m1[1];
  const m2 = url.match(/[?&]pageId=(\d+)/i);
  if (m2) return m2[1];
  return null;
}

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
        sources.push({
          type: "attachment",
          label: `Attachment ${i + 1} — ${a.filename}`,
          text: `File "${a.filename}" (${a.mimeType || "unknown"}, ${sizeKb} KB) uploaded by ${a.author} on ${a.created?.slice(0, 10)}.`,
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

  return sources;
}

// --- 2. Pure function from src/frontend/index.jsx ---

function splitIntoPartsWithGroupedCitations(text) {
  const tokens = [];
  const regex = /\[(\d+)\]/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }
    tokens.push({ type: "marker", value: parseInt(match[1], 10) });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    tokens.push({ type: "text", value: text.slice(lastIndex) });
  }

  const parts = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.type === "text") {
      parts.push(token);
      i++;
      continue;
    }
    const group = [token.value];
    let j = i + 1;
    while (j < tokens.length) {
      if (tokens[j].type === "marker") {
        group.push(tokens[j].value);
        j++;
      } else if (tokens[j].type === "text" && tokens[j].value.trim() === "") {
        j++;
      } else {
        break;
      }
    }
    parts.push({ type: "citation-group", markers: group });
    i = j;
  }

  return parts;
}

// --- Test Suites ---

async function runAllTests() {
  console.log("Running Recuerdo Test Suite...\n");
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
      failed++;
    }
  }

  // --- Suite 1: Fingerprint hashing & change detection ---
  console.log("Suite 1: Content Fingerprinting & Cache Invalidation");
  const baseIssue = {
    description: "Initial issue description.",
    status: "In Progress",
    resolution: null,
    comments: [
      { id: "101", created: "2026-11-20T10:00:00Z", text: "Looking into it." },
      { id: "102", created: "2026-11-20T11:00:00Z", text: "Found the bug." },
    ],
  };

  test("identical content generates identical fingerprint", () => {
    const fp1 = computeContentFingerprint(baseIssue);
    const fp2 = computeContentFingerprint({ ...baseIssue });
    assert.equal(fp1, fp2);
    assert.ok(typeof fp1 === "string" && fp1.length > 0);
  });

  test("detects description edits", () => {
    const fp1 = computeContentFingerprint(baseIssue);
    const fp2 = computeContentFingerprint({
      ...baseIssue,
      description: "Edited issue description.",
    });
    assert.notEqual(fp1, fp2);
  });

  test("detects new comment additions", () => {
    const fp1 = computeContentFingerprint(baseIssue);
    const fp2 = computeContentFingerprint({
      ...baseIssue,
      comments: [
        ...baseIssue.comments,
        { id: "103", created: "2026-11-20T12:00:00Z", text: "Deployed fix." },
      ],
    });
    assert.notEqual(fp1, fp2);
  });

  test("detects comment edits", () => {
    const fp1 = computeContentFingerprint(baseIssue);
    const fp2 = computeContentFingerprint({
      ...baseIssue,
      comments: [
        baseIssue.comments[0],
        { id: "102", created: "2026-11-20T11:00:00Z", text: "Found the bug in redis." },
      ],
    });
    assert.notEqual(fp1, fp2);
  });

  test("detects status and resolution changes", () => {
    const fp1 = computeContentFingerprint(baseIssue);
    const fp2 = computeContentFingerprint({
      ...baseIssue,
      status: "Closed",
      resolution: "Fixed",
    });
    assert.notEqual(fp1, fp2);
  });

  test("detects attachment additions and removals in fingerprint", () => {
    const fp1 = computeContentFingerprint(baseIssue);
    const fp2 = computeContentFingerprint({
      ...baseIssue,
      attachments: [
        { id: "att-1", filename: "error.log", size: 4096 },
      ],
    });
    assert.notEqual(fp1, fp2);
  });

  test("detects changelog transitions in fingerprint", () => {
    const fp1 = computeContentFingerprint(baseIssue);
    const fp2 = computeContentFingerprint({
      ...baseIssue,
      transitions: [
        { field: "status", from: "In Progress", to: "Done", created: "2026-11-20T12:00:00Z" },
      ],
    });
    assert.notEqual(fp1, fp2);
  });

  // --- Suite 2: Citation grouping parser ---
  console.log("\nSuite 2: Citation Grouping & Token Parsing");

  test("handles text without citations", () => {
    const parts = splitIntoPartsWithGroupedCitations("Plain text without markers.");
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, "text");
    assert.equal(parts[0].value, "Plain text without markers.");
  });

  test("handles single citation marker", () => {
    const parts = splitIntoPartsWithGroupedCitations("Fixed in PR [1].");
    assert.equal(parts.length, 3);
    assert.equal(parts[0].value, "Fixed in PR ");
    assert.deepEqual(parts[1], { type: "citation-group", markers: [1] });
    assert.equal(parts[2].value, ".");
  });

  test("groups adjacent citations [1][2] into single group badge", () => {
    const parts = splitIntoPartsWithGroupedCitations("Caused by config mismatch [1][2].");
    const group = parts.find((p) => p.type === "citation-group");
    assert.ok(group);
    assert.deepEqual(group.markers, [1, 2]);
  });

  test("groups adjacent citations with spaces [1] [2] [3]", () => {
    const parts = splitIntoPartsWithGroupedCitations("Confirmed by team [1] [2] [3].");
    const group = parts.find((p) => p.type === "citation-group");
    assert.ok(group);
    assert.deepEqual(group.markers, [1, 2, 3]);
  });

  test("keeps non-adjacent citations separate", () => {
    const parts = splitIntoPartsWithGroupedCitations("Found root cause [1] and deployed fix [2].");
    const groups = parts.filter((p) => p.type === "citation-group");
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].markers, [1]);
    assert.deepEqual(groups[1].markers, [2]);
  });

  // --- Suite 3: Long thread budgeting & windowing ---
  console.log("\nSuite 3: Long Comment Thread Windowing & Truncation");

  test("preserves all comments if thread <= 20 comments", () => {
    const comments = Array.from({ length: 15 }, (_, i) => ({
      id: `c-${i + 1}`,
      author: `User ${i + 1}`,
      text: `Comment ${i + 1} content`,
    }));
    const sources = buildSourceList({
      description: "Test issue",
      comments,
      selection: { description: true, comments: true },
    });
    // 1 description + 15 comments = 16 sources
    assert.equal(sources.length, 16);
    assert.equal(sources[0].type, "description");
    assert.equal(sources[1].label, "Comment 1 — User 1");
    assert.equal(sources[15].label, "Comment 15 — User 15");
  });

  test("smartly windows 50 comments (first 5 + omitted notice + last 15)", () => {
    const comments = Array.from({ length: 50 }, (_, i) => ({
      id: `c-${i + 1}`,
      author: `User ${i + 1}`,
      text: `Comment ${i + 1} content`,
    }));
    const sources = buildSourceList({
      description: "Test issue",
      comments,
      selection: { description: true, comments: true },
    });
    // 1 description + 5 head comments + 1 omitted notice + 15 tail comments = 22 sources
    assert.equal(sources.length, 22);
    assert.equal(sources[0].type, "description");
    assert.equal(sources[1].label, "Comment 1 — User 1");
    assert.equal(sources[5].label, "Comment 5 — User 5");
    // Omitted notice
    assert.equal(sources[6].label, "Comments 6 to 35 (Omitted)");
    assert.ok(sources[6].text.includes("30 intermediate discussion comments omitted"));
    // Tail comments start at comment 36
    assert.equal(sources[7].label, "Comment 36 — User 36");
    assert.equal(sources[21].label, "Comment 50 — User 50");
  });

  test("truncates extremely large single comments (> 1200 chars)", () => {
    const hugeText = "A".repeat(5000);
    const truncated = truncateText(hugeText, 1200);
    assert.ok(truncated.length < 1400);
    assert.ok(truncated.includes("[...truncated 3800 characters of logs/stacktrace...]"));
  });

  // --- Suite 4: Attachments and Status Changelog Sources ---
  console.log("\nSuite 4: Attachments and Status Changelog Sources");

  test("correctly includes attachments and status transitions in sources", () => {
    const sources = buildSourceList({
      description: "Sample issue",
      comments: [{ id: "c1", author: "Alice", text: "Working on it" }],
      attachments: [{ id: "att-1", filename: "patch.diff", mimeType: "text/x-patch", size: 2048, author: "Alice", created: "2026-11-20" }],
      transitions: [{ field: "status", from: "Open", to: "Done", author: "Bob", created: "2026-11-20T15:00:00" }],
      selection: { description: true, comments: true, attachments: true, history: true },
    });
    assert.equal(sources.length, 4);
    assert.equal(sources[0].type, "description");
    assert.equal(sources[1].type, "comment");
    assert.equal(sources[2].type, "attachment");
    assert.equal(sources[2].label, "Attachment 1 — patch.diff");
    assert.equal(sources[3].type, "history");
    assert.equal(sources[3].label, "Transition 1 — status (Bob)");
  });

  test("honors deselected categories (e.g. excluding comments and history)", () => {
    const sources = buildSourceList({
      description: "Sample issue",
      comments: [{ id: "c1", author: "Alice", text: "Working on it" }],
      attachments: [{ id: "att-1", filename: "patch.diff", mimeType: "text/x-patch", size: 2048, author: "Alice", created: "2026-11-20" }],
      transitions: [{ field: "status", from: "Open", to: "Done", author: "Bob", created: "2026-11-20T15:00:00" }],
      selection: { description: true, comments: false, attachments: true, history: false },
    });
    assert.equal(sources.length, 2);
    assert.equal(sources[0].type, "description");
    assert.equal(sources[1].type, "attachment");
  });

  // --- Suite 5: Confluence Integration ---
  console.log("\nSuite 5: Confluence Integration");

  test("extracts Confluence Page ID from standard spaces/pages URL", () => {
    const url = "https://my-team.atlassian.net/wiki/spaces/ENG/pages/987654321/Auth+Service+Architecture";
    assert.equal(extractConfluencePageId(url), "987654321");
  });

  test("extracts Confluence Page ID from viewpage.action URL", () => {
    const url = "https://my-team.atlassian.net/wiki/pages/viewpage.action?pageId=11223344";
    assert.equal(extractConfluencePageId(url), "11223344");
  });

  test("returns null for non-confluence or invalid URLs", () => {
    assert.equal(extractConfluencePageId("https://google.com"), null);
    assert.equal(extractConfluencePageId("https://my-team.atlassian.net/browse/REC-101"), null);
  });

  test("correctly includes Confluence pages in sources with deep links", () => {
    const sources = buildSourceList({
      description: "Sample issue",
      comments: [],
      confluencePages: [
        {
          pageId: "987654321",
          title: "Auth Service Architecture",
          url: "https://my-team.atlassian.net/wiki/spaces/ENG/pages/987654321/Auth+Service+Architecture",
          text: "Design specifies Redis TTL should be 24 hours.",
        },
      ],
      selection: { description: true, comments: false, confluence: true },
    });
    assert.equal(sources.length, 2);
    assert.equal(sources[0].type, "description");
    assert.equal(sources[1].type, "confluence");
    assert.equal(sources[1].label, "Confluence Doc 1 — Auth Service Architecture");
    assert.equal(sources[1].confluenceUrl, "https://my-team.atlassian.net/wiki/spaces/ENG/pages/987654321/Auth+Service+Architecture");
  });

  test("detects Confluence doc edits in fingerprint", () => {
    const fp1 = computeContentFingerprint(baseIssue);
    const fp2 = computeContentFingerprint({
      ...baseIssue,
      confluencePages: [
        { pageId: "987654321", title: "Auth Doc", text: "New architecture notes" },
      ],
    });
    assert.notEqual(fp1, fp2);
  });

  // --- Suite 6: Empty ticket resilience ---
  console.log("\nSuite 6: Empty Ticket Resilience");

  test("empty description and empty comments produces clear placeholder sources", () => {
    const sources = buildSourceList({
      description: "",
      comments: [],
      selection: { description: true, comments: true },
    });
    assert.equal(sources.length, 2);
    assert.equal(sources[0].text, "(No description was written on this issue.)");
    assert.equal(sources[1].text, "(No comments have been posted on this issue.)");
  });

  console.log(`\n================ TEST SUMMARY ================`);
  console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`==============================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests();
