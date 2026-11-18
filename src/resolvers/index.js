import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';

const resolver = new Resolver();

resolver.define('getIssueContext', async (req) => {
  const { issueKey } = req.payload;

  if (!issueKey) {
    return { error: 'No issue key provided' };
  }

  try {
    // Fetch the issue itself (status, summary, description, resolution)
    const issueRes = await api.asUser().requestJira(
      route`/rest/api/3/issue/${issueKey}?fields=summary,status,resolution,description`
    );
    const issue = await issueRes.json();

    // Fetch comments on the issue
    const commentsRes = await api.asUser().requestJira(
      route`/rest/api/3/issue/${issueKey}/comment`
    );
    const commentsData = await commentsRes.json();

    const comments = (commentsData.comments || []).map((c) => ({
      author: c.author?.displayName || 'Unknown',
      created: c.created,
      // body is Atlassian Document Format (ADF); extract plain text
      text: extractTextFromADF(c.body),
    }));

    const title = issue.fields?.summary;
    const status = issue.fields?.status?.name;
    const resolution = issue.fields?.resolution?.name || null;
    const description = extractTextFromADF(issue.fields?.description);

    // Build a single numbered list of everything the AI is allowed to cite.
    // This is the one place that knows about "sources" as a concept — if we
    // add attachments, Confluence pages, etc. later, they just get appended
    // here and everything downstream (prompt, frontend) keeps working as-is.
    const sources = buildSourceList({ description, comments });

    // Ask the AI backend (via the Lambda proxy) for a cited summary of why
    // this issue was closed/resolved. We always return the raw issue data
    // even if the AI call fails, so the panel can still show something.
    const aiResult = await getAiSummary({ issueKey, title, status, resolution, sources });

    return {
      summary: title,
      status,
      resolution,
      comments,
      description,
      sources,
      aiSummary: aiResult.summary || null,
      aiCitations: aiResult.citations || [],
      aiError: aiResult.error || null,
    };
  } catch (err) {
    console.error('Error fetching issue context:', err);
    return { error: err.message };
  }
});

// Builds the unified, numbered list of citable sources. Index in this array
// (1-based) is exactly the citation marker number the AI will use, and what
// the frontend looks up when the user clicks a [n] marker.
function buildSourceList({ description, comments }) {
  const sources = [];

  if (description) {
    sources.push({
      type: 'description',
      label: 'Issue description',
      text: description,
    });
  }

  comments.forEach((c, i) => {
    sources.push({
      type: 'comment',
      label: `Comment ${i + 1} — ${c.author}`,
      text: c.text,
    });
  });

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
    console.error('LAMBDA_PROXY_URL or LAMBDA_PROXY_SECRET is not configured');
    return { error: 'AI backend is not configured' };
  }

  if (!sources || sources.length === 0) {
    // Nothing to summarize — don't waste a call on an issue with no content.
    return { summary: null };
  }

  const prompt = buildPrompt({ issueKey, title, status, resolution, sources });

  try {
    const res = await api.fetch(proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-recuerdo-secret': proxySecret,
      },
      body: JSON.stringify({ prompt }),
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      console.error(`Lambda proxy returned ${res.status}: ${bodyText}`);
      return { error: `AI backend error (status ${res.status})` };
    }

    const data = await res.json();

    if (data.error) {
      console.error('Lambda proxy reported an error:', data.error);
      return { error: data.error };
    }

    return { summary: data.summary || null, citations: data.citations || [] };
  } catch (err) {
    console.error('Error calling Lambda proxy:', err);
    return { error: 'Could not reach AI backend' };
  }
}

// Builds the prompt sent to the AI model. Asks for STRUCTURED JSON output:
// a summary with [n] citation markers inline, plus a citations array
// explaining why each marker was cited. The source list is numbered exactly
// as buildSourceList() numbered it, so markers map directly to sources[] on
// the frontend with no fuzzy matching required.
function buildPrompt({ issueKey, title, status, resolution, sources }) {
  const sourceBlock = sources
    .map((s, i) => `[${i + 1}] ${s.label}:\n${s.text}`)
    .join('\n\n');

  return [
    `You are summarizing why a Jira issue was closed or resolved, for a teammate who is about to re-investigate it.`,
    `Issue: ${issueKey} — "${title}"`,
    `Status: ${status}${resolution ? `, Resolution: ${resolution}` : ''}`,
    ``,
    `Here are the available sources, numbered:`,
    ``,
    sourceBlock,
    ``,
    `Respond with ONLY a JSON object (no markdown, no code fences) in this exact shape:`,
    `{`,
    `  "summary": "A short 2-4 sentence summary of the actual decision made and why, with inline citation markers like [1] or [2] placed right after each claim they support.",`,
    `  "citations": [`,
    `    { "marker": 1, "reason": "One short sentence on why source [1] supports that specific claim." }`,
    `  ]`,
    `}`,
    ``,
    `Rules:`,
    `- Only cite source numbers that actually exist in the list above.`,
    `- Every citation marker used in "summary" must have a matching entry in "citations".`,
    `- If the sources don't contain a clear decision or reason, say so plainly in "summary" instead of guessing, and return an empty "citations" array.`,
  ].join('\n');
}

// Minimal ADF-to-text extractor — walks the document tree and pulls text nodes
function extractTextFromADF(adf) {
  if (!adf || !adf.content) return '';
  let text = '';
  const walk = (node) => {
    if (node.type === 'text') {
      text += node.text;
    }
    if (node.content) {
      node.content.forEach(walk);
    }
    if (node.type === 'paragraph') {
      text += '\n';
    }
  };
  adf.content.forEach(walk);
  return text.trim();
}

export const handler = resolver.getDefinitions();
