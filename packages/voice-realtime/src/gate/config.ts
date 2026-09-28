/**
 * Call gate settings (env). The gate authenticates a PSTN caller with Twilio
 * <Gather> — speech passphrase or keypad PIN — before any model hears the call.
 */

function envTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/**
 * Passphrase words as speech hints (default on). Hints make Twilio's
 * recognizer far more likely to hear the passphrase right, but they appear in
 * the TwiML Twilio logs. `JOSHU_VOICE_GATE_HINTS=0` turns them off.
 */
export function voiceGateHintsEnabled(): boolean {
  return !/^(0|false|no|off)$/i.test(envTrim("JOSHU_VOICE_GATE_HINTS"));
}

/** Optional Twilio speechModel (e.g. `experimental_utterances`); unset = Twilio default. */
export function voiceGateSpeechModel(): string {
  return envTrim("JOSHU_VOICE_GATE_SPEECH_MODEL");
}

/**
 * Twilio allows `speechTimeout="auto"` only without a speechModel; with one it
 * must be whole seconds.
 */
export function voiceGateSpeechTimeout(): string {
  if (!voiceGateSpeechModel()) return "auto";
  const seconds = Number.parseInt(envTrim("JOSHU_VOICE_GATE_SPEECH_TIMEOUT"), 10);
  return String(Number.isFinite(seconds) && seconds > 0 ? seconds : 1);
}

export function twilioAuthToken(): string {
  return envTrim("TWILIO_AUTH_TOKEN");
}

export function twilioAccountSid(): string {
  return envTrim("TWILIO_ACCOUNT_SID");
}
