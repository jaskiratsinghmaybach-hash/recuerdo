import React, { useEffect, useState, useCallback } from "react";
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
  Popup,
  Checkbox,
  xcss,
} from "@forge/react";
import { invoke, view } from "@forge/bridge";

// Display labels for each source category in the filter panel. Add an entry
// here (and a matching default in the resolver's DEFAULT_SELECTION) when a
// new source type, like Confluence pages, is introduced.
const SOURCE_CATEGORY_LABELS = {
  description: "Issue description",
  comments: "Comments",
};

// Per-source-type styling for inline citation markers: icon glyph plus a
// distinct accent color, so each citation reads as a small colored pill
// badge (not a bare bracketed number) and visually hints at its source type
// before the user even clicks it. Falls back to a neutral/link style for
// any future source type we haven't special-cased yet.
const SOURCE_TYPE_STYLES = {
  comment: {
    glyph: "comment",
    background: "color.background.accent.blue.subtler",
    border: "color.border.accent.blue",
  },
  description: {
    glyph: "document",
    background: "color.background.accent.green.subtler",
    border: "color.border.accent.green",
  },
};
const DEFAULT_SOURCE_STYLE = {
  glyph: "link",
  background: "color.background.accent.gray.subtler",
  border: "color.border.accent.gray",
};

function styleForSourceType(type) {
  return SOURCE_TYPE_STYLES[type] || DEFAULT_SOURCE_STYLE;
}

// Splits a string like "Tokens expired early [3] due to a TTL change [1]."
// into plain text segments and GROUPS of citation marker numbers. Adjacent
// markers with nothing but whitespace between them (e.g. "[3][4]" or
// "[3] [4]") are grouped into a single badge instead of rendering one badge
// per marker — this is the fix for icon clutter when several sources
// support the same claim right next to each other.
function splitIntoPartsWithGroupedCitations(text) {
  // First pass: tokenize into plain-text runs and individual marker numbers.
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

  // Second pass: merge a marker with any immediately-following markers that
  // are separated only by whitespace (no other text) into one citation group.
  const parts = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.type === "text") {
      parts.push(token);
      i++;
      continue;
    }
    // token.type === 'marker' — start a new group and absorb any markers
    // that follow, skipping over whitespace-only text tokens in between.
    const group = [token.value];
    let j = i + 1;
    while (j < tokens.length) {
      if (tokens[j].type === "marker") {
        group.push(tokens[j].value);
        j++;
      } else if (tokens[j].type === "text" && tokens[j].value.trim() === "") {
        j++; // whitespace between adjacent markers — keep looking
      } else {
        break; // real text content — group ends here
      }
    }
    parts.push({ type: "citation-group", markers: group });
    i = j;
  }

  return parts;
}

// Renders one block of AI output (a paragraph or a bulleted list), resolving
// citation marker groups into clickable pill badges via onCitationClick.
function BodyBlock({ block, sources, onCitationClick }) {
  const renderTextWithCitations = (text, keyPrefix) => {
    const parts = splitIntoPartsWithGroupedCitations(text);
    return parts.map((part, i) => {
      if (part.type === "text") {
        return part.value; // plain string — stays inline, no wrapping element
      }
      // citation-group: style the badge after its FIRST source (arbitrary
      // but consistent choice when a group spans more than one type).
      const firstSource = sources[part.markers[0] - 1];
      const style = styleForSourceType(firstSource?.type);
      return (
        <Pressable
          key={`${keyPrefix}-${i}`}
          onClick={() => onCitationClick(part.markers)}
          padding="space.025"
          backgroundColor={style.background}
          xcss={xcss({
            borderRadius: "radius.full",
            borderStyle: "solid",
            borderWidth: "border.width",
            borderColor: style.border,
          })}
        >
          <Icon
            glyph={style.glyph}
            label={`View ${part.markers.length > 1 ? "citation sources" : "citation source"}`}
            size="small"
          />
        </Pressable>
      );
    });
  };

  if (block.type === "bullets") {
    return (
      <Stack space="space.050">
        {block.items.map((item, idx) => (
          <Inline key={idx} space="space.075" alignBlock="start">
            <Text>•</Text>
            <Text>{renderTextWithCitations(item, `b${idx}`)}</Text>
          </Inline>
        ))}
      </Stack>
    );
  }

  // "paragraph"
  return <Text>{renderTextWithCitations(block.text, "p")}</Text>;
}

const App = () => {
  const [context, setContext] = useState(null);
  const [issueKey, setIssueKey] = useState(null);
  const [siteUrl, setSiteUrl] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [activeMarkers, setActiveMarkers] = useState(null); // array of marker numbers, or null if closed
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [savingSelection, setSavingSelection] = useState(false);

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

  const handleToggleSource = async (category, nextValue) => {
    if (!issueKey || savingSelection || !context?.selection) return;
    setSavingSelection(true);
    const nextSelection = { ...context.selection, [category]: nextValue };
    await invoke("setSourceSelection", { issueKey, selection: nextSelection });
    // The resolver clears the cached AI result whenever the selection
    // changes, so this reload regenerates the summary with the new sources
    // without the user needing to separately hit Refresh too.
    await loadContext(issueKey, false);
    setSavingSelection(false);
  };

  if (!context) {
    return <Text>Loading...</Text>;
  }

  if (context.error) {
    return <Text>Error: {context.error}</Text>;
  }

  const hasComments = context.comments && context.comments.length > 0;
  const sources = context.sources || [];
  const citations = context.aiCitations || [];
  const aiBody = context.aiBody || [];

  // The modal can show one or several sources at once (a merged citation
  // group). Build the list of {source, reason} pairs it needs.
  const activeEntries = (activeMarkers || [])
    .map((marker) => ({
      marker,
      source: sources[marker - 1],
      reason: citations.find((c) => c.marker === marker)?.reason,
    }))
    .filter((entry) => entry.source);

  const buildJiraUrl = (source) =>
    source && siteUrl && issueKey
      ? source.commentId
        ? `${siteUrl}/browse/${issueKey}?focusedCommentId=${source.commentId}`
        : `${siteUrl}/browse/${issueKey}`
      : null;

  return (
    <Stack space="space.200">
      <Inline space="space.100" alignBlock="center" spread="space-between">
        <Heading size="small">recuerdo</Heading>
        <Inline space="space.075" alignBlock="center">
          <Popup
            isOpen={isFilterOpen}
            onClose={() => setIsFilterOpen(false)}
            placement="bottom-end"
            trigger={() => (
              <Pressable
                onClick={() => setIsFilterOpen((open) => !open)}
                padding="space.050"
                backgroundColor="color.background.neutral.subtle"
              >
                <Icon
                  glyph="filter"
                  label="Choose which sources to include"
                  size="small"
                />
              </Pressable>
            )}
            content={() => (
              <Stack space="space.100">
                <Text weight="bold">Sources to include</Text>
                {Object.entries(SOURCE_CATEGORY_LABELS).map(
                  ([category, label]) => (
                    <Checkbox
                      key={category}
                      label={label}
                      isChecked={context.selection?.[category] ?? true}
                      isDisabled={savingSelection}
                      onChange={(e) =>
                        handleToggleSource(category, e.target.checked)
                      }
                    />
                  ),
                )}
              </Stack>
            )}
          />
          <Button
            appearance="subtle"
            onClick={handleRefresh}
            isDisabled={refreshing}
          >
            {refreshing ? "Refreshing..." : "Refresh"}
          </Button>
        </Inline>
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
        {(hasComments || context.description) && context.aiHeading && (
          <SectionMessage appearance="information">
            <Stack space="space.100">
              <Text weight="bold">{context.aiHeading}</Text>
              <Stack space="space.100">
                {aiBody.map((block, i) => (
                  <BodyBlock
                    key={i}
                    block={block}
                    sources={sources}
                    onCitationClick={setActiveMarkers}
                  />
                ))}
              </Stack>
            </Stack>
          </SectionMessage>
        )}
        {(hasComments || context.description) &&
          !context.aiHeading &&
          context.aiError && (
            <SectionMessage appearance="warning">
              <Text>
                Couldn't generate a summary right now: {context.aiError}
              </Text>
            </SectionMessage>
          )}
        {(hasComments || context.description) &&
          !context.aiHeading &&
          !context.aiError && <Text>No summary available.</Text>}
      </Stack>

      <ModalTransition>
        {activeEntries.length > 0 && (
          <Modal onClose={() => setActiveMarkers(null)}>
            <ModalHeader>
              <ModalTitle>
                {activeEntries.length === 1
                  ? activeEntries[0].source.label
                  : `${activeEntries.length} sources`}
              </ModalTitle>
            </ModalHeader>
            <ModalBody>
              <Stack space="space.200">
                {activeEntries.map((entry, i) => {
                  const jiraUrl = buildJiraUrl(entry.source);
                  return (
                    <Stack key={i} space="space.100">
                      {activeEntries.length > 1 && (
                        <Text weight="bold">{entry.source.label}</Text>
                      )}
                      <Text>{entry.source.text}</Text>
                      {entry.reason && (
                        <SectionMessage
                          appearance="discovery"
                          title="Why recuerdo cited this"
                        >
                          <Text>{entry.reason}</Text>
                        </SectionMessage>
                      )}
                      {jiraUrl && (
                        <Inline>
                          <LinkButton
                            href={jiraUrl}
                            target="_blank"
                            appearance="default"
                          >
                            View in Jira
                          </LinkButton>
                        </Inline>
                      )}
                    </Stack>
                  );
                })}
              </Stack>
            </ModalBody>
            <ModalFooter>
              <Button
                appearance="subtle"
                onClick={() => setActiveMarkers(null)}
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
