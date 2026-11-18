import React, { useEffect, useState, useCallback, useMemo } from "react";
import ForgeReconciler, {
  Text,
  Stack,
  Inline,
  Lozenge,
  SectionMessage,
  Heading,
  Button,
  LinkButton,
  Pressable,
  Icon,
  Modal,
  ModalBody,
  ModalHeader,
  ModalTitle,
  ModalFooter,
  ModalTransition,
} from "@forge/react";
import { invoke, view } from "@forge/bridge";

// Which icon glyph represents each source type in an inline citation marker.
// Falls back to 'link' for any future source type we haven't special-cased.
function iconGlyphForSourceType(type) {
  if (type === "comment") return "comment";
  if (type === "description") return "document";
  return "link";
}

// Splits a summary string like "Tokens expired early [3] due to a TTL change [1]."
// into plain text segments and citation marker numbers, in order, so we can
// render the markers as clickable elements inline with the rest of the text.
function splitSummaryIntoParts(summary) {
  const parts = [];
  const regex = /\[(\d+)\]/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(summary)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        type: "text",
        value: summary.slice(lastIndex, match.index),
      });
    }
    parts.push({ type: "citation", marker: parseInt(match[1], 10) });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < summary.length) {
    parts.push({ type: "text", value: summary.slice(lastIndex) });
  }

  return parts;
}

const App = () => {
  const [context, setContext] = useState(null);
  const [issueKey, setIssueKey] = useState(null);
  const [siteUrl, setSiteUrl] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [activeCitation, setActiveCitation] = useState(null); // marker number, or null if closed

  const loadContext = useCallback((key, forceRefresh) => {
    return invoke("getIssueContext", { issueKey: key, forceRefresh }).then(
      setContext,
    );
  }, []);

  useEffect(() => {
    view.getContext().then((ctx) => {
      const key = ctx.extension.issue.key;
      setIssueKey(key);
      // siteUrl is Forge's own reliable site domain (e.g.
      // https://one-atlas-xltb.atlassian.net) — unlike the Jira REST API's
      // "self" fields, which can point at an internal api.atlassian.com
      // proxy URL instead. We use this to build correct "View in Jira" links.
      setSiteUrl(ctx.siteUrl);
      // Initial load: never forces a refresh. If a cached AI result exists
      // from a previous session, the resolver returns it instantly with no
      // new AI call — the summary only regenerates when the user explicitly
      // clicks Refresh below.
      loadContext(key, false);
    });
  }, [loadContext]);

  const handleRefresh = async () => {
    if (!issueKey || refreshing) return;
    setRefreshing(true);
    await loadContext(issueKey, true);
    setRefreshing(false);
  };

  const summaryParts = useMemo(() => {
    if (!context?.aiSummary) return [];
    return splitSummaryIntoParts(context.aiSummary);
  }, [context?.aiSummary]);

  if (!context) {
    return <Text>Loading...</Text>;
  }

  if (context.error) {
    return <Text>Error: {context.error}</Text>;
  }

  const hasComments = context.comments && context.comments.length > 0;
  const sources = context.sources || [];
  const citations = context.aiCitations || [];

  // Look up everything the modal needs for the currently open citation.
  const activeSource = activeCitation ? sources[activeCitation - 1] : null;
  const activeReason = activeCitation
    ? citations.find((c) => c.marker === activeCitation)?.reason
    : null;

  // Built here, not in the resolver, because siteUrl (Forge's own reliable
  // site domain) is only available on the frontend via view.getContext().
  const activeJiraUrl =
    activeSource && siteUrl && issueKey
      ? activeSource.commentId
        ? `${siteUrl}/browse/${issueKey}?focusedCommentId=${activeSource.commentId}`
        : `${siteUrl}/browse/${issueKey}`
      : null;

  return (
    <Stack space="space.200">
      <Inline space="space.100" alignBlock="center" spread="space-between">
        <Heading size="small">recuerdo</Heading>
        <Button
          appearance="subtle"
          onClick={handleRefresh}
          isDisabled={refreshing}
        >
          {refreshing ? "Refreshing..." : "Refresh"}
        </Button>
      </Inline>

      <Stack space="space.100">
        <Text>
          Status: <Lozenge>{context.status}</Lozenge>
        </Text>
        {context.resolution && <Text>Resolution: {context.resolution}</Text>}
      </Stack>

      <Stack space="space.075">
        <Heading size="small">Why this was resolved</Heading>
        {!hasComments && !context.description && (
          <Text>
            No description or comments on this issue yet — nothing to summarize.
          </Text>
        )}
        {(hasComments || context.description) && context.aiSummary && (
          <SectionMessage appearance="information">
            <Text>
              {summaryParts.map((part, i) => {
                if (part.type === "text") {
                  // Plain string, not wrapped in another Text — keeps it
                  // flowing inline with the citation markers on either side
                  // instead of each fragment becoming its own block/line.
                  return part.value;
                }
                const matchedSource = sources[part.marker - 1];
                const glyph = iconGlyphForSourceType(matchedSource?.type);
                return (
                  <Pressable
                    key={i}
                    onClick={() => setActiveCitation(part.marker)}
                    padding="space.0"
                    backgroundColor="color.background.neutral.subtle"
                  >
                    <Icon
                      glyph={glyph}
                      label={`View citation source: ${matchedSource?.label || "source"}`}
                      size="small"
                    />
                  </Pressable>
                );
              })}
            </Text>
          </SectionMessage>
        )}
        {(hasComments || context.description) &&
          !context.aiSummary &&
          context.aiError && (
            <SectionMessage appearance="warning">
              <Text>
                Couldn't generate a summary right now: {context.aiError}
              </Text>
            </SectionMessage>
          )}
        {(hasComments || context.description) &&
          !context.aiSummary &&
          !context.aiError && <Text>No summary available.</Text>}
      </Stack>

      <ModalTransition>
        {activeCitation && activeSource && (
          <Modal onClose={() => setActiveCitation(null)}>
            <ModalHeader>
              <ModalTitle>{activeSource.label}</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <Stack space="space.150">
                <Text>{activeSource.text}</Text>
                {activeReason && (
                  <SectionMessage
                    appearance="discovery"
                    title="Why recuerdo cited this"
                  >
                    <Text>{activeReason}</Text>
                  </SectionMessage>
                )}
              </Stack>
            </ModalBody>
            <ModalFooter>
              {activeJiraUrl && (
                <LinkButton
                  href={activeJiraUrl}
                  target="_blank"
                  appearance="default"
                >
                  View in Jira
                </LinkButton>
              )}
              <Button
                appearance="subtle"
                onClick={() => setActiveCitation(null)}
              >
                Close
              </Button>
            </ModalFooter>
          </Modal>
        )}
      </ModalTransition>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
