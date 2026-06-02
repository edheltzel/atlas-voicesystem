import type { PiVoiceConfig } from "./config.ts";

export const DEFAULT_PI_NOTIFY_TIMEOUT_MS = 10_000;

export interface PiNotifyPayload {
  message: string;
  title?: string;
  voice_id?: string;
  voice_enabled?: boolean;
  session_id?: string;
  source: "pi";
}

export interface PiNotifyResult {
  ok: boolean;
  status: number;
  body: string;
}

export function buildPiNotifyPayload(
  config: PiVoiceConfig,
  message: string,
  sessionId?: string,
): PiNotifyPayload {
  const payload: PiNotifyPayload = {
    message,
    title: config.title,
    voice_enabled: config.voiceEnabled,
    source: "pi",
  };
  if (config.voiceId) payload.voice_id = config.voiceId;
  if (sessionId) payload.session_id = sessionId;
  return payload;
}

function signalWithTimeout(parentSignal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromParent = () => controller.abort(parentSignal?.reason);

  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

export async function sendPiNotification(
  config: PiVoiceConfig,
  message: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<PiNotifyResult> {
  const timeout = signalWithTimeout(signal, DEFAULT_PI_NOTIFY_TIMEOUT_MS);

  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPiNotifyPayload(config, message, sessionId)),
      signal: timeout.signal,
    });

    return {
      ok: response.ok,
      status: response.status,
      body: await response.text(),
    };
  } finally {
    timeout.cleanup();
  }
}
