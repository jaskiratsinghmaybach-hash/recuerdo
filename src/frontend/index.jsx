import React, { useEffect, useState, useCallback, useMemo } from "react";
import ForgeReconciler, {
  Text,
  Stack,
  Inline,
  Lozenge,
  SectionMessage,
  Strong,
  Heading,
  Button,
  Pressable,
  Modal,
  ModalBody,
  ModalHeader,
  ModalTitle,
  ModalFooter,
  ModalTransition,
} from "@forge/react";
import { invoke, view } from "@forge/bridge";

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
  const [refreshing, setRefreshing] = useState(false);
  const [activeCitation, setActiveCitation] = useState(null); // marker number, or null if closed

  const loadContext = useCallback((key) => {
    return invoke("getIssueContext", { issueKey: key }).then(setContext);
  }, []);

  useEffect(() => {
    view.getContext().then((ctx) => {
      const key = ctx.extension.issue.key;
      setIssueKey(key);
      loadContext(key);
    });
  }, [loadContext]);

  const handleRefresh = async () => {
    if (!issueKey || refreshing) return;
    setRefreshing(true);
    await loadContext(issueKey);
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
              {summaryParts.map((part, i) =>
                part.type === "text" ? (
                  <Text key={i}>{part.value}</Text>
                ) : (
                  <Pressable
                    key={i}
                    onClick={() => setActiveCitation(part.marker)}
                    padding="space.0"
                    backgroundColor="color.background.neutral.subtle"
                  >
                    <Text>
                      <Strong>[{part.marker}]</Strong>
                    </Text>
                  </Pressable>
                ),
              )}
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

      {hasComments && (
        <Stack space="space.075">
          <Heading size="small">Comments ({context.comments.length})</Heading>
          {context.comments.map((c, i) => (
            <Text key={i}>
              <Strong>
                Comment {i + 1} — {c.author}:
              </Strong>{" "}
              {c.text}
            </Text>
          ))}
        </Stack>
      )}

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
