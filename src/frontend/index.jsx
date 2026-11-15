import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Text, Stack, Lozenge } from '@forge/react';
import { invoke, view } from '@forge/bridge';

const App = () => {
  const [context, setContext] = useState(null);
  const [issueKey, setIssueKey] = useState(null);

  useEffect(() => {
    view.getContext().then((ctx) => {
      const key = ctx.extension.issue.key;
      setIssueKey(key);
      invoke('getIssueContext', { issueKey: key }).then(setContext);
    });
  }, []);

  if (!context) {
    return <Text>Loading...</Text>;
  }

  if (context.error) {
    return <Text>Error: {context.error}</Text>;
  }

  return (
    <Stack space="space.100">
      <Text>
        Status: <Lozenge>{context.status}</Lozenge>
      </Text>
      {context.resolution && <Text>Resolution: {context.resolution}</Text>}
      <Text>Comments found: {context.comments.length}</Text>
      {context.comments.map((c, i) => (
        <Text key={i}>
          {c.author}: {c.text}
        </Text>
      ))}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
