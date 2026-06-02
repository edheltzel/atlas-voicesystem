export interface PiVoiceConfig {
  endpoint: string;
  title: string;
  catchphrase: string;
  voiceId?: string;
  voiceEnabled: boolean;
  greetOnSessionStart: boolean;
  speakCompletions: boolean;
  suppressInSubagents: boolean;
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function loadPiVoiceConfig(env: Record<string, string | undefined> = process.env): PiVoiceConfig {
  return {
    endpoint: env.ATLAS_VOICE_NOTIFY_URL || env.VOICESYSTEM_NOTIFY_URL || "http://localhost:8888/notify",
    title: env.ATLAS_VOICE_TITLE || "Pi Notification",
    catchphrase: env.ATLAS_VOICE_CATCHPHRASE || "Pi session ready.",
    voiceId: env.ATLAS_VOICE_ID || env.VOICESYSTEM_VOICE_ID || undefined,
    voiceEnabled: booleanEnv(env.ATLAS_VOICE_ENABLED, true),
    greetOnSessionStart: booleanEnv(env.ATLAS_VOICE_GREET_ON_START, true),
    speakCompletions: booleanEnv(env.ATLAS_VOICE_SPEAK_COMPLETIONS, true),
    suppressInSubagents: booleanEnv(env.ATLAS_VOICE_SUPPRESS_SUBAGENTS, true),
  };
}

export function shouldSuppressVoice(env: Record<string, string | undefined> = process.env): boolean {
  if (booleanEnv(env.ATLAS_VOICE_SUPPRESS, false)) return true;
  if (env.PI_SUBAGENT_CHILD === "1") return true;
  if (env.PI_SUBAGENT_FANOUT_CHILD === "1") return true;
  if (env.PI_SUBAGENT_PARENT_RUN_ID) return true;
  return false;
}
