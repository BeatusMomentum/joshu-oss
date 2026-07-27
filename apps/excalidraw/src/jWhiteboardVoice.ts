import { JoshuVoiceClient } from "@joshu/voice-client";

export type WhiteboardVoiceStatus = {
  available: boolean;
  configured?: boolean;
};

export async function fetchWhiteboardVoiceStatus(
  voiceApiBase: string,
): Promise<WhiteboardVoiceStatus> {
  try {
    const response = await fetch(`${voiceApiBase}/status`, { cache: "no-store" });
    if (!response.ok) return { available: false };
    return (await response.json()) as WhiteboardVoiceStatus;
  } catch {
    return { available: false };
  }
}

export async function startWhiteboardVoiceSession(params: {
  voiceApiBase: string;
  sessionId: string;
  chatSessionId: string;
  surface: {
    appId: string;
    threadId: string;
    guiSnapshot: Record<string, unknown>;
    voiceCommands?: Array<{
      name: string;
      phrases: string[];
      action: string;
      params?: string[];
      description?: string;
    }>;
  };
  onUserTranscript?: (text: string, partial: boolean) => void;
  onAssistantDelta?: (delta: string) => void;
  onAssistantDone?: (text: string) => void;
  onState?: (state: string) => void;
  onAppAction?: (event: {
    appId: string;
    action: string;
    args?: Record<string, unknown>;
  }) => void;
  onBargeIn?: () => void;
  onThinkJobStart?: () => void;
  onError?: (message: string) => void;
}): Promise<{ client: JoshuVoiceClient; stop: () => Promise<void> }> {
  const response = await fetch(
    `${params.voiceApiBase}/session?chatSessionId=${encodeURIComponent(params.chatSessionId)}`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(await response.text());
  const payload = (await response.json()) as { wsUrl?: string };
  if (!payload.wsUrl) throw new Error("Voice session missing wsUrl");

  const client = new JoshuVoiceClient({
    wsUrl: payload.wsUrl,
    sessionId: `web:${params.sessionId}`,
    chatSessionId: params.chatSessionId,
    surface: params.surface,
    onUserTranscript: params.onUserTranscript,
    onAssistantDelta: params.onAssistantDelta,
    onAssistantDone: params.onAssistantDone,
    onAppAction: params.onAppAction,
    onThinkJobStart: params.onThinkJobStart,
    onState: params.onState,
    onBargeIn: params.onBargeIn,
    onError: params.onError,
  });
  await client.start();
  return { client, stop: () => client.stop() };
}
