import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useAgent, useCopilotKit, UseAgentUpdate } from "@copilotkit/react-core/v2";
import { JChatThread } from "@joshu/jchat-ui";

import { mapAgUiMessagesToJChat } from "./mapAgUiMessagesToJChat.js";
import {
  claimProgrammaticPromptRequest,
  type JoshuProgrammaticPromptRequest,
} from "./programmaticPromptRequest.js";

export type JChatCopilotThreadProps = {
  agentId: string;
  emptyText?: string;
  placeholder?: string;
  disabled?: boolean;
  companionAvatarUrl?: string;
  companionName?: string;
  userAvatarUrl?: string | null;
  userName?: string;
  /** App-originated prompt; `id` is consumed once within `promptRequestScope`. */
  promptRequest?: JoshuProgrammaticPromptRequest | null;
  promptRequestScope?: string;
  /** Durable async goal delivery queue for this embedded app thread. */
  realtimeGoalSessionKey?: string;
  apiBase?: string;
};

/** CopilotKit agent run wired to the shared jChat thread UI. */
export function JChatCopilotThread({
  agentId,
  emptyText,
  placeholder,
  disabled = false,
  companionAvatarUrl,
  companionName,
  userAvatarUrl,
  userName,
  promptRequest,
  promptRequestScope,
  realtimeGoalSessionKey,
  apiBase = "/joshu/api",
}: JChatCopilotThreadProps): React.ReactElement {
  const { copilotkit } = useCopilotKit();
  const { agent } = useAgent({
    agentId,
    updates: [UseAgentUpdate.OnMessagesChanged, UseAgentUpdate.OnRunStatusChanged],
  });
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!realtimeGoalSessionKey) return;
    const storageKey = `joshu:realtime-goals:${realtimeGoalSessionKey}`;
    let stopped = false;
    let polling = false;
    const seenEventIds = new Set(agent.messages.map((message) => message.id));

    try {
      const cached = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as Array<{
        id?: string;
        text?: string;
      }>;
      for (const event of cached) {
        if (!event.id || !event.text) continue;
        if (!seenEventIds.has(event.id)) {
          agent.addMessage({ id: event.id, role: "assistant", content: event.text });
          seenEventIds.add(event.id);
        }
      }
    } catch {
      /* ignore corrupt browser cache */
    }

    const poll = async () => {
      if (stopped || polling || agent.isRunning) return;
      polling = true;
      try {
        const response = await fetch(
          `${apiBase}/realtime-goals/surface-events?sessionKey=${encodeURIComponent(realtimeGoalSessionKey)}`,
          { cache: "no-store" },
        );
        if (!response.ok) return;
        const payload = (await response.json()) as {
          events?: Array<{ id?: string; text?: string }>;
        };
        for (const event of payload.events ?? []) {
          if (!event.id || !event.text || stopped) continue;
          let browserPersisted = false;
          try {
            const cached = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as Array<{
              id?: string;
              text?: string;
            }>;
            const next = [
              ...cached.filter((item) => item.id !== event.id),
              { id: event.id, text: event.text },
            ].slice(-50);
            localStorage.setItem(storageKey, JSON.stringify(next));
            browserPersisted = true;
          } catch {
            /* leave server event unconsumed for retry */
          }
          if (!seenEventIds.has(event.id)) {
            agent.addMessage({ id: event.id, role: "assistant", content: event.text });
            seenEventIds.add(event.id);
          }
          if (browserPersisted) {
            await fetch(
              `${apiBase}/realtime-goals/surface-events/${encodeURIComponent(event.id)}/consume`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sessionKey: realtimeGoalSessionKey }),
              },
            );
          }
        }
      } catch {
        // Box may be warming. The next poll retries without disturbing chat.
      } finally {
        polling = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 5_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [agent, agent.isRunning, apiBase, realtimeGoalSessionKey]);

  const messages = useMemo(
    () => mapAgUiMessagesToJChat(agent.messages, agent.isRunning),
    [agent.isRunning, agent.messages],
  );

  useEffect(() => {
    if (!promptRequest || agent.isRunning || disabled) return;
    const claimed = claimProgrammaticPromptRequest(
      promptRequestScope ?? agentId,
      promptRequest,
    );
    if (!claimed) return;

    agent.addMessage({
      id: claimed.id,
      role: "user",
      content: claimed.text,
    });
    void copilotkit.runAgent({ agent }).catch((error) => {
      console.error("[JChatCopilotThread] programmatic runAgent failed", error);
    });
  }, [
    agent,
    agent.isRunning,
    agentId,
    copilotkit,
    disabled,
    promptRequest,
    promptRequestScope,
  ]);

  const sendMessage = useCallback(async () => {
    const text = draft.trim();
    if (!text || agent.isRunning || disabled) return;
    setDraft("");
    agent.addMessage({
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    });
    try {
      await copilotkit.runAgent({ agent });
    } catch (error) {
      console.error("[JChatCopilotThread] runAgent failed", error);
    }
  }, [agent, copilotkit, disabled, draft]);

  return (
    <JChatThread
      messages={messages}
      draft={draft}
      onDraftChange={setDraft}
      onSend={() => void sendMessage()}
      busy={agent.isRunning}
      disabled={disabled}
      emptyText={emptyText}
      placeholder={placeholder}
      companionAvatarUrl={companionAvatarUrl}
      companionName={companionName}
      userAvatarUrl={userAvatarUrl}
      userName={userName}
    />
  );
}
