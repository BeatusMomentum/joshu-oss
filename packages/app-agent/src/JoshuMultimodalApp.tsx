import React, { useMemo } from "react";

import {
  JoshuEmbeddedAppAgent,
  type JoshuEmbeddedAppAgentProps,
  type JoshuGuiAgentRef,
} from "./JoshuEmbeddedAppAgent.js";
import { useAppAgentChatSession } from "./useAppAgentChatSession.js";
import type { JoshuAppAgentManifest } from "./types.js";
import type { JoshuGuiActionInput } from "./useJoshuGuiAction.js";

export type JoshuMultimodalAppProps<TGui extends JoshuGuiAgentRef = JoshuGuiAgentRef> = {
  manifest: JoshuAppAgentManifest;
  guiRef: React.MutableRefObject<TGui | null>;
  createGuiActions: (guiRef: React.MutableRefObject<TGui | null>) => readonly JoshuGuiActionInput[];
  apiBase?: string;
  chatScope?: string;
  guiReadableDescription: string;
  chatTitle?: string;
  voice?: JoshuEmbeddedAppAgentProps["voice"];
  /** App-originated chat turn (e.g. notify user when a background job completes). */
  promptRequest?: JoshuEmbeddedAppAgentProps["promptRequest"];
  children: React.ReactNode;
};

/**
 * Multimodal desktop app shell — chat + voice + guiActions wired from one manifest.
 * Apps supply domain guiRef handlers; this component owns thread/session wiring.
 */
export function JoshuMultimodalApp<TGui extends JoshuGuiAgentRef>({
  manifest,
  guiRef,
  createGuiActions,
  apiBase = "/joshu/api",
  chatScope,
  guiReadableDescription,
  chatTitle,
  voice,
  promptRequest,
  children,
}: JoshuMultimodalAppProps<TGui>): React.ReactElement {
  const { threadId, startNewChat } = useAppAgentChatSession({
    appId: manifest.id,
    scope: chatScope,
    apiBase,
  });
  const guiActions = useMemo(() => createGuiActions(guiRef), [createGuiActions, guiRef]);

  return (
    <>
      {children}
      <JoshuEmbeddedAppAgent
        key={threadId}
        manifest={manifest}
        threadId={threadId}
        apiBase={apiBase}
        guiRef={guiRef}
        guiReadableDescription={guiReadableDescription}
        guiActions={guiActions}
        chatTitle={chatTitle ?? manifest.name}
        onNewChat={startNewChat}
        voice={voice}
        promptRequest={promptRequest}
      />
    </>
  );
}
