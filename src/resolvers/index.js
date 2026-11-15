import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';

const resolver = new Resolver();

resolver.define('getIssueContext', async (req) => {
  const { issueKey } = req.payload;

  if (!issueKey) {
    return { error: 'No issue key provided' };
  }

  try {
    // Fetch the issue itself (status, summary)
    const issueRes = await api.asUser().requestJira(
      route`/rest/api/3/issue/${issueKey}?fields=summary,status,resolution`
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

    return {
      summary: issue.fields?.summary,
      status: issue.fields?.status?.name,
      resolution: issue.fields?.resolution?.name || null,
      comments,
    };
  } catch (err) {
    console.error('Error fetching issue context:', err);
    return { error: err.message };
  }
});

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
