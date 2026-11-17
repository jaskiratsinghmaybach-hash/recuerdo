import React, { useEffect, useState } from "react";
import ForgeReconciler, {
  Text,
  Stack,
  Lozenge,
  SectionMessage,
  Strong,
  Heading,
} from "@forge/react";
import { invoke, view } from "@forge/bridge";

const App = () => {
  const [context, setContext] = useState(null);

  useEffect(() => {
    view.getContext().then((ctx) => {
      const key = ctx.extension.issue.key;
      invoke("getIssueContext", { issueKey: key }).then(setContext);
    });
  }, []);

  if (!context) {
    return <Text>Loading...</Text>;
  }

  if (context.error) {
    return <Text>Error: {context.error}</Text>;
  }

  const hasComments = context.comments && context.comments.length > 0;

  return (
    <Stack space="space.200">
      <Stack space="space.100">
        <Text>
          Status: <Lozenge>{context.status}</Lozenge>
        </Text>
        {context.resolution && <Text>Resolution: {context.resolution}</Text>}
      </Stack>

      <Stack space="space.075">
        <Heading size="small">Why this was resolved</Heading>
        {!hasComments && (
          <Text>No comments on this issue yet — nothing to summarize.</Text>
        )}
        {hasComments && context.aiSummary && (
          <SectionMessage appearance="information">
            <Text>{context.aiSummary}</Text>
          </SectionMessage>
        )}
        {hasComments && !context.aiSummary && context.aiError && (
          <SectionMessage appearance="warning">
            <Text>
              Couldn't generate a summary right now: {context.aiError}
            </Text>
          </SectionMessage>
        )}
        {hasComments && !context.aiSummary && !context.aiError && (
          <Text>No summary available.</Text>
        )}
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
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
