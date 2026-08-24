import React, { useMemo } from "react";
import { JoshuEmbeddedAppAgent } from "@joshu/app-agent";

import { createMdEditorGuiActions, type MdEditorGuiAgentApi } from "./mdEditorGuiActions.js";
import { MD_EDITOR_MANIFEST } from "./mdEditorManifest.js";

export type { MdEditorGuiAgentApi };

export type MdEditorAgentBridgeProps = {
  guiRef: React.MutableRefObject<MdEditorGuiAgentApi | null>;
  threadId: string;
  onNewChat?: () => void | Promise<void>;
};

export function MdEditorAgentBridge({
  guiRef,
  threadId,
  onNewChat,
}: MdEditorAgentBridgeProps): React.ReactElement {
  const guiActions = useMemo(() => createMdEditorGuiActions(guiRef), [guiRef]);

  return (
    <JoshuEmbeddedAppAgent
      manifest={MD_EDITOR_MANIFEST}
      threadId={threadId}
      guiRef={guiRef}
      guiReadableDescription="Current jNotes UI state (activeView: editor, open file path, dirty flag, markdown preview)"
      guiActions={guiActions}
      chatTitle="jNotes"
      onNewChat={onNewChat}
    />
  );
}
