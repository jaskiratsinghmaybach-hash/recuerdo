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
  Box,
  xcss,
  Textfield,
  Spinner,
  Tooltip,
  Form,
  Image,
  User,
} from "@forge/react";
import { invoke, view } from "@forge/bridge";
import { RECUERDO_AVATAR } from "./avatar";

// Display labels for each source category in the filter panel.
const SOURCE_CATEGORY_LABELS = {
  description: "Issue description",
  confluence: "Confluence pages",
  comments: "Comments",
  attachments: "Attachments",
  history: "Status changelog",
};

// Dynamic contextual suggested starter prompts tailored to the issue state
function getSuggestedPrompts(context, issueKey) {
  if (!context) {
    return 'Try: "What was the root cause?" or "Who investigated this?"';
  }

  // Derive a stable seed from issue key so suggestions vary across issues
  const seed = (issueKey || "").split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);

  // If issue is still under active investigation / open
  if (context.effectivelyResolved === false) {
    const openPool = [
      'Try: "What is currently blocking resolution?" or "What were the latest findings?"',
      'Try: "Who was the last person working on this?" or "What was ruled out so far?"',
      'Try: "What error logs or stack traces were analyzed?" or "What are the recommended next steps?"',
      'Try: "Where does the investigation stand?" or "Has this been reproduced locally?"',
      'Try: "What was the last actor doing when activity stopped?" or "Who owns the next action?"',
    ];
    return openPool[seed % openPool.length];
  }

  // If issue was resolved / closed
  const resolvedPool = [
    'Try: "What was the root cause of the issue?" or "Who investigated and fixed this?"',
    'Try: "Why was this specific fix chosen?" or "How was it verified in testing?"',
    'Try: "What configuration or code was modified?" or "What logs were reviewed?"',
    'Try: "Were any Confluence post-mortems or docs linked?" or "Who verified the fix?"',
    'Try: "What were the symptoms before the fix?" or "What metrics confirmed recovery?"',
    'Try: "Who authored the fix and who reviewed it?" or "What was the timeline to resolve?"',
  ];
  return resolvedPool[seed % resolvedPool.length];
}

// Per-source-type styling for inline citation markers: icon glyph plus a
// distinct accent color, so each citation reads as a small colored pill
// badge (not a bare bracketed number) and visually hints at its source type
// before the user even clicks it.
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
  attachment: {
    glyph: "attachment",
    background: "color.background.accent.orange.subtler",
    border: "color.border.accent.orange",
  },
  history: {
    glyph: "time",
    background: "color.background.accent.purple.subtler",
    border: "color.border.accent.purple",
  },
  confluence: {
    glyph: "page",
    background: "color.background.accent.teal.subtler",
    border: "color.border.accent.teal",
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

// Renders text with inline clickable citation pills
function renderTextWithCitations(text, keyPrefix, sources, onCitationClick) {
  const parts = splitIntoPartsWithGroupedCitations(text || "");
  return parts.map((part, i) => {
    if (part.type === "text") {
      return part.value;
    }
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
}

// Renders one block of AI output (a paragraph or a bulleted list), resolving
// citation marker groups into clickable pill badges via onCitationClick.
function BodyBlock({ block, sources, onCitationClick }) {
  if (block.type === "bullets") {
    return (
      <Stack space="space.050">
        {block.items.map((item, idx) => (
          <Inline key={idx} space="space.075" alignBlock="start">
            <Text>•</Text>
            <Text>
              {renderTextWithCitations(
                item,
                `b${idx}`,
                sources,
                onCitationClick,
              )}
            </Text>
          </Inline>
        ))}
      </Stack>
    );
  }

  // "paragraph"
  return (
    <Text>
      {renderTextWithCitations(block.text, "p", sources, onCitationClick)}
    </Text>
  );
}

const App = () => {
  const [context, setContext] = useState(null);
  const [issueKey, setIssueKey] = useState(null);
  const [siteUrl, setSiteUrl] = useState(null);
  const [currentAccountId, setCurrentAccountId] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [activeMarkers, setActiveMarkers] = useState(null); // array of marker numbers, or null if closed
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [liveSelection, setLiveSelection] = useState(null);

  // Feature 2: In-Panel Chat State
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [isSendingChat, setIsSendingChat] = useState(false);
  const [copiedMsgId, setCopiedMsgId] = useState(null);

  const handleCopyMessage = useCallback((msgId, text) => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        navigator.clipboard.writeText(text);
      }
    } catch (e) {
      // ignore
    }
    setCopiedMsgId(msgId);
    setTimeout(() => {
      setCopiedMsgId((current) => (current === msgId ? null : current));
    }, 2000);
  }, []);

  const loadContext = useCallback((key, forceRefresh) => {
    return invoke("getIssueContext", { issueKey: key, forceRefresh }).then(
      (result) => {
        setContext(result);
        if (result?.selection) {
          setLiveSelection(result.selection);
        }
      },
    );
  }, []);

  const loadChatHistory = useCallback((key) => {
    invoke("getChatHistory", { issueKey: key }).then((res) => {
      if (res?.messages) {
        setChatMessages(res.messages);
      }
    });
  }, []);

  useEffect(() => {
    view.getContext().then((ctx) => {
      const key = ctx.extension.issue.key;
      setIssueKey(key);
      setSiteUrl(ctx.siteUrl);
      setCurrentAccountId(ctx.accountId || null);
      loadContext(key, false);
      loadChatHistory(key);
    });
  }, [loadContext, loadChatHistory]);

  const hasPendingSelectionChange =
    context?.appliedSelection &&
    liveSelection &&
    Object.keys(liveSelection).some(
      (key) =>
        Boolean(liveSelection[key]) !== Boolean(context.appliedSelection[key]),
    );

  const handleRefreshOrApply = async () => {
    if (!issueKey || refreshing) return;
    setRefreshing(true);
    if (liveSelection) {
      await invoke("setSourceSelection", {
        issueKey,
        selection: liveSelection,
      });
    }
    await loadContext(issueKey, true);
    setRefreshing(false);
  };

  const handleToggleSource = (category, nextValue) => {
    if (!liveSelection) return;
    setLiveSelection({ ...liveSelection, [category]: nextValue });
  };

  const handleSendChatMessage = async () => {
    const question = chatInput.trim();
    if (!question || isSendingChat || !issueKey) return;
    setChatInput("");
    setIsSendingChat(true);

    // Optimistically add user message immediately (with pfp accountId so the avatar shows right away)
    const tempUserMsg = {
      id: `temp-${Date.now()}`,
      authorName: "You",
      authorAccountId: currentAccountId || null,
      isUser: true,
      text: question,
      timestamp: new Date().toISOString(),
    };
    setChatMessages((prev) => [...prev, tempUserMsg]);

    const res = await invoke("sendChatMessage", {
      issueKey,
      question,
      userName: "You",
      accountId: currentAccountId,
    });

    if (res?.messages) {
      setChatMessages(res.messages);
    } else if (res?.error) {
      setChatMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          authorName: "Recuerdo",
          isUser: false,
          text: `Couldn't answer right now: ${res.error}`,
          citations: [],
          timestamp: new Date().toISOString(),
        },
      ]);
    }
    setIsSendingChat(false);
  };

  const handleClearChat = async () => {
    if (!issueKey) return;
    await invoke("clearChatHistory", { issueKey });
    setChatMessages([]);
  };

  if (!context) {
    return <Text>Loading...</Text>;
  }

  if (context.error) {
    return <Text>Error: {context.error}</Text>;
  }

  const sources = context.sources || [];
  const citations = context.aiCitations || [];
  const aiBody = context.aiBody || [];

  // Combine citations across summary and all chat messages so clicking [n]
  // anywhere displays the correct supporting reason
  const allCitations = [
    ...citations,
    ...chatMessages.flatMap((m) => m.citations || []),
  ];

  const activeEntries = (activeMarkers || [])
    .map((marker) => ({
      marker,
      source: sources[marker - 1],
      reason: allCitations.find((c) => c.marker === marker)?.reason,
    }))
    .filter((entry) => entry.source);

  const buildSourceUrl = (source) => {
    if (!source) return null;
    if (source.type === "confluence" && source.confluenceUrl) {
      return source.confluenceUrl;
    }
    if (siteUrl && issueKey) {
      return source.commentId
        ? `${siteUrl}/browse/${issueKey}?focusedCommentId=${source.commentId}`
        : `${siteUrl}/browse/${issueKey}`;
    }
    return null;
  };

  const sectionHeadingText =
    context.sectionTitle ||
    (context.effectivelyResolved === false
      ? "Where this stands"
      : "Why this was resolved");

  return (
    <Stack space="space.200">
      {/* Top Action Bar */}
      <Inline space="space.100" alignBlock="center" spread="space-between">
        {/* Ask AI toggle — same subtle ghost style as Sources and Refresh */}
        <Button
          appearance="subtle"
          iconBefore={isChatOpen ? "cross" : "comment"}
          onClick={() => setIsChatOpen((open) => !open)}
        >
          {isChatOpen ? "Close" : "Ask AI"}
        </Button>

        <Inline space="space.075" alignBlock="center">
          <Popup
            isOpen={isFilterOpen}
            onClose={() => setIsFilterOpen(false)}
            placement="bottom-end"
            trigger={() => (
              <Button
                appearance="subtle"
                iconBefore="filter"
                onClick={() => setIsFilterOpen((open) => !open)}
              >
                Sources
              </Button>
            )}
            content={() => (
              <Box
                padding="space.150"
                backgroundColor="elevation.surface.overlay"
                xcss={xcss({
                  borderRadius: "radius.medium",
                  boxShadow: "elevation.shadow.overlay",
                })}
              >
                <Stack space="space.100">
                  <Text weight="bold">Sources to include</Text>
                  {Object.entries(SOURCE_CATEGORY_LABELS).map(
                    ([category, label]) => (
                      <Checkbox
                        key={category}
                        label={label}
                        isChecked={liveSelection?.[category] ?? true}
                        onChange={(e) =>
                          handleToggleSource(category, e.target.checked)
                        }
                      />
                    ),
                  )}
                </Stack>
              </Box>
            )}
          />
          <Button
            appearance="subtle"
            onClick={handleRefreshOrApply}
            isDisabled={refreshing}
          >
            {refreshing
              ? hasPendingSelectionChange
                ? "Regenerating..."
                : "Refreshing..."
              : hasPendingSelectionChange
                ? "Apply & Regenerate"
                : "Refresh"}
          </Button>
        </Inline>
      </Inline>

      {/* VIEW A: Normal Summary View (Chat Closed) */}
      {!isChatOpen && (
        <Stack space="space.075">
          <Heading size="small">{sectionHeadingText}</Heading>
          {context.aiHeading && (
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
          {!context.aiHeading && context.aiError && (
            <SectionMessage appearance="warning">
              <Text>
                Couldn't generate a summary right now: {context.aiError}
              </Text>
            </SectionMessage>
          )}
          {!context.aiHeading && !context.aiError && (
            <Text>
              No description, comments, or activity available to summarize.
            </Text>
          )}
        </Stack>
      )}

      {/* VIEW B: In-Panel Chat (Wireframe design — fixed height inner scroll) */}
      {isChatOpen && (
        <Stack space="space.100">

          {/* ── Briefing card: collapsed summary pinned at top of chat ── */}
          {context.aiHeading && (
            <Box
              backgroundColor="elevation.surface.sunken"
              padding="space.100"
              xcss={xcss({ borderRadius: "radius.medium" })}
            >
              <Stack space="space.050">
                <Inline space="space.050" alignBlock="center">
                  <Icon glyph="lightbulb" size="small" label="Briefing" />
                  <Text weight="bold" size="small">
                    {sectionHeadingText}: {context.aiHeading}
                  </Text>
                </Inline>
                {aiBody.map((block, i) => (
                  <BodyBlock
                    key={i}
                    block={block}
                    sources={sources}
                    onCitationClick={setActiveMarkers}
                  />
                ))}
              </Stack>
            </Box>
          )}

          {/* ── Scrollable message list — fixed height so panel never grows ── */}
          <Box
            xcss={xcss({
              height: "340px",
              overflowY: "auto",
              overflowX: "hidden",
            })}
          >
            <Stack space="space.150" padding="space.050">



              {chatMessages.map((msg) => {
                // Format timestamp for the tooltip label — shown on hover of avatar
                const tooltipLabel = msg.timestamp
                  ? new Date(msg.timestamp).toLocaleString([], {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "";

                // ── Helper: derive initials from a display name ──
                // "Jaskirat Singh" → "JS", "You" → "Y", "Recuerdo" → "R"
                const initials = (name) =>
                  (name || "?")
                    .split(" ")
                    .map((w) => w[0] || "")
                    .join("")
                    .toUpperCase()
                    .slice(0, 2);

                if (msg.isUser) {
                  // ── RIGHT-SIDE: user message ──
                  // Desired layout: [Real Name text] ──spread── [pfp circle only]
                  // The name now comes from the resolver which fetches it from Jira
                  // (e.g. "Jaskirat Singh"). The pfp is on the far right.
                  const name = msg.authorName || "You";
                  const abbr = initials(name);
                  return (
                    <Stack key={msg.id} space="space.050" alignBlock="end">
                      {/* Name (left of the pfp) + pfp (rightmost) — spread pushes them apart */}
                      <Inline spread="end" space="space.075" alignBlock="center">
                        <Text size="small" color="color.text.subtle" weight="medium">
                          {name}
                        </Text>
                        {/*
                          Use Forge's <User> component to display the real Jira profile picture.
                          hideDisplayName={true} shows ONLY the avatar circle, not the name text —
                          we already render the name ourselves on the left.
                          If there is no accountId, fall back to a subtle initials circle.
                        */}
                        {msg.authorAccountId ? (
                          <Tooltip content={tooltipLabel || name} position="top">
                            <User accountId={msg.authorAccountId} hideDisplayName={true} />
                          </Tooltip>
                        ) : (
                          <Tooltip content={tooltipLabel || name} position="top">
                            <Box
                              backgroundColor="color.background.accent.blue.subtler"
                              paddingBlock="space.025"
                              paddingInline="space.075"
                              xcss={xcss({
                                borderRadius: "radius.full",
                                borderStyle: "solid",
                                borderWidth: "border.width",
                                borderColor: "color.border.accent.blue",
                                textAlign: "center",
                              })}
                            >
                              <Text size="small" color="color.text.accent.blue.bolder" weight="bold">
                                {abbr}
                              </Text>
                            </Box>
                          </Tooltip>
                        )}
                      </Inline>
                      {/* Message bubble — right-aligned, subtle blue tint */}
                      <Inline spread="end">
                        <Box
                          backgroundColor="color.background.accent.blue.subtler"
                          padding="space.100"
                          xcss={xcss({
                            borderRadius: "radius.medium",
                            maxWidth: "85%",
                          })}
                        >
                          <Text>{msg.text}</Text>
                        </Box>
                      </Inline>
                    </Stack>
                  );
                }

                // ── LEFT-SIDE: Recuerdo AI message ──
                // Layout: [logo circle] [Recuerdo text] — vertically centered by Inline alignBlock
                return (
                  <Stack key={msg.id} space="space.050">
                    {/*
                      Header row. The Tooltip wraps only the avatar box so the text "Recuerdo"
                      doesn't interfere with centering. We use space.300 (= 24px) design tokens
                      for width/height so Forge's xcss engine applies them correctly.
                    */}
                    <Inline space="space.075" alignBlock="center">
                      <Tooltip content={tooltipLabel || "Recuerdo"} position="top">
                        <Box
                          xcss={xcss({
                            width: "space.300",
                            height: "space.300",
                            borderRadius: "radius.full",
                          })}
                        >
                          <Image
                            src={RECUERDO_AVATAR}
                            alt="Recuerdo"
                            size="small"
                            width={24}
                            height={24}
                          />
                        </Box>
                      </Tooltip>
                      <Text size="small" color="color.text.subtle" weight="medium">
                        Recuerdo
                      </Text>
                    </Inline>
                    {/* AI message card — sunken bg, no border, rounded corners */}
                    <Box
                      backgroundColor="elevation.surface.sunken"
                      padding="space.100"
                      xcss={xcss({
                        borderRadius: "radius.medium",
                        maxWidth: "90%",
                      })}
                    >
                      <Text>
                        {renderTextWithCitations(
                          msg.text,
                          msg.id,
                          sources,
                          setActiveMarkers,
                        )}
                      </Text>
                    </Box>
                  </Stack>
                );
              })}

              {/* ── Thinking indicator while AI is processing ── */}
              {isSendingChat && (
                <Stack space="space.050">
                  <Inline space="space.075" alignBlock="center">
                    <Tooltip content="Recuerdo" position="top">
                      <Box
                        xcss={xcss({
                          width: "space.300",
                          height: "space.300",
                          borderRadius: "radius.full",
                        })}
                      >
                        <Image
                          src={RECUERDO_AVATAR}
                          alt="Recuerdo"
                          size="small"
                          width={24}
                          height={24}
                        />
                      </Box>
                    </Tooltip>
                    <Text size="small" color="color.text.subtle" weight="medium">Recuerdo</Text>
                  </Inline>
                  <Box
                    backgroundColor="elevation.surface.sunken"
                    padding="space.100"
                    xcss={xcss({ borderRadius: "radius.medium", maxWidth: "90%" })}
                  >
                    <Inline space="space.075" alignBlock="center">
                      <Spinner size="small" />
                      <Text size="small" color="color.text.subtle">
                        Reviewing sources...
                      </Text>
                    </Inline>
                  </Box>
                </Stack>
              )}

            </Stack>
          </Box>

          {/* ── Empty state hint — sits just above the input bar with dynamic suggestions ── */}
          {chatMessages.length === 0 && !isSendingChat && (
            <Box
              padding="space.075"
              xcss={xcss({ borderRadius: "radius.medium" })}
            >
              <Text size="small" color="color.text.subtlest">
                No questions asked yet. {getSuggestedPrompts(context, issueKey)}
              </Text>
            </Box>
          )}

          {/* ── Chat input bar with Enter key submit support ── */}
          <Form onSubmit={handleSendChatMessage}>
            <Inline space="space.075" alignBlock="center">
              {/* Message box with 0 radius and pointy corners */}
              <Box
                backgroundColor="elevation.surface"
                xcss={xcss({
                  borderStyle: "solid",
                  borderWidth: "border.width",
                  borderColor: "color.border",
                  flexGrow: 1,
                })}
              >
                <Textfield
                  name="chatInput"
                  appearance="none"
                  placeholder="Ask Recuerdo..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  isDisabled={isSendingChat}
                />
              </Box>
              {/* Send button with 0 radius, pointy corners, and permanent white background */}
              <Pressable
                onClick={() => {
                  if (!isSendingChat && chatInput.trim()) handleSendChatMessage();
                }}
                xcss={xcss({
                  width: "36px",
                  height: "36px",
                  borderStyle: "solid",
                  borderWidth: "border.width",
                  borderColor: "color.border",
                  backgroundColor: "elevation.surface",
                  textAlign: "center",
                  cursor: chatInput.trim() && !isSendingChat ? "pointer" : "default",
                })}
              >
                <Inline alignBlock="center" alignInline="center">
                  <Icon glyph="send" label="Send message" size="medium" />
                </Inline>
              </Pressable>
            </Inline>
          </Form>

          {/* ── Footer ── */}
          <Inline spread="space-between" alignBlock="center">
            <Text size="small" color="color.text.subtlest">
              Shared team memory
            </Text>
            {chatMessages.length > 0 && (
              <Button appearance="subtle" onClick={handleClearChat}>
                Clear conversation
              </Button>
            )}
          </Inline>

        </Stack>
      )}

      {/* Interactive Citation Inspection Modal */}
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
                  const sourceUrl = buildSourceUrl(entry.source);
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
                      {sourceUrl && (
                        <Inline>
                          <LinkButton
                            href={sourceUrl}
                            target="_blank"
                            appearance="default"
                          >
                            {entry.source.type === "confluence"
                              ? "View in Confluence"
                              : "View in Jira"}
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
