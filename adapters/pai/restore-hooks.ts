#!/usr/bin/env bun
// Idempotently re-applies atlas-voicesystem's PAI settings.json hook registrations.
// Safe to run repeatedly. Backs up settings.json before mutating.

import { chmodSync, copyFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(ADAPTER_DIR));
const SETTINGS_PATH = process.env.PAI_SETTINGS_PATH || join(homedir(), ".claude/settings.json");
const REPO_HOOKS_DIR = join(ADAPTER_DIR, "hooks");
const LEGACY_HOOKS_DIR = join(REPO_ROOT, "claudecode/.claude/PAI/USER/Voice/hooks");

// Historical duplicate-detection paths from the original fixed clone location.
// New registrations always use the repo root derived from import.meta.url above.
const HISTORICAL_REPO_ROOT = join(homedir(), "Developer/atlas-voicesystem");
const HISTORICAL_ADAPTER_HOOKS_DIR = join(HISTORICAL_REPO_ROOT, "adapters/pai/hooks");
const HISTORICAL_LEGACY_HOOKS_DIR = join(
  HISTORICAL_REPO_ROOT,
  "claudecode/.claude/PAI/USER/Voice/hooks",
);

const VOICE_GATE_CMD = join(REPO_HOOKS_DIR, "VoiceGate.hook.ts");
const VOICE_GREETING_CMD = join(REPO_HOOKS_DIR, "VoiceGreeting.hook.ts");
const DUPLICATE_VOICE_GATE_CMDS = new Set([
  VOICE_GATE_CMD,
  join(LEGACY_HOOKS_DIR, "VoiceGate.hook.ts"),
  join(HISTORICAL_ADAPTER_HOOKS_DIR, "VoiceGate.hook.ts"),
  join(HISTORICAL_LEGACY_HOOKS_DIR, "VoiceGate.hook.ts"),
]);
const DUPLICATE_VOICE_GREETING_CMDS = new Set([
  VOICE_GREETING_CMD,
  join(LEGACY_HOOKS_DIR, "VoiceGreeting.hook.ts"),
  join(HISTORICAL_ADAPTER_HOOKS_DIR, "VoiceGreeting.hook.ts"),
  join(HISTORICAL_LEGACY_HOOKS_DIR, "VoiceGreeting.hook.ts"),
]);

const CHECK_ONLY = process.argv.includes("--check");

type HookEntry = { type?: string; command: string };
type MatcherEntry = { matcher?: string; hooks: HookEntry[] };
type Settings = { hooks?: Record<string, MatcherEntry[]>; [k: string]: unknown };

function loadSettings(): Settings {
  const raw = readFileSync(SETTINGS_PATH, "utf8");
  return JSON.parse(raw) as Settings;
}

function hookExists(entry: MatcherEntry, commands: Set<string>): boolean {
  return entry.hooks.some((hook) => commands.has(hook.command));
}

const settings = loadSettings();
settings.hooks ??= {};
settings.hooks.PreToolUse ??= [];
settings.hooks.SessionStart ??= [];

let changed = false;
const log: string[] = [];

// 1) Add VoiceGate to existing PreToolUse matcher="Bash" entry.
const bashEntry = settings.hooks.PreToolUse.find((entry) => entry.matcher === "Bash");
if (!bashEntry) {
  console.error("FATAL: no PreToolUse matcher='Bash' entry found in settings.json");
  process.exit(2);
}

if (!hookExists(bashEntry, DUPLICATE_VOICE_GATE_CMDS)) {
  bashEntry.hooks.push({ type: "command", command: VOICE_GATE_CMD });
  changed = true;
  log.push("+ PreToolUse[matcher=Bash] += VoiceGate.hook.ts");
} else {
  log.push("= PreToolUse[matcher=Bash] already has VoiceGate.hook.ts");
}

// 2) Add SessionStart matcher="startup" entry with VoiceGreeting.
let startupEntry = settings.hooks.SessionStart.find((entry) => entry.matcher === "startup");
if (!startupEntry) {
  startupEntry = { matcher: "startup", hooks: [] };
  settings.hooks.SessionStart.push(startupEntry);
  changed = true;
  log.push('+ SessionStart += { matcher: "startup", hooks: [] }');
}

if (!hookExists(startupEntry, DUPLICATE_VOICE_GREETING_CMDS)) {
  startupEntry.hooks.push({ type: "command", command: VOICE_GREETING_CMD });
  changed = true;
  log.push("+ SessionStart[matcher=startup] += VoiceGreeting.hook.ts");
} else {
  log.push("= SessionStart[matcher=startup] already has VoiceGreeting.hook.ts");
}

if (CHECK_ONLY) {
  log.push(changed ? "✓ preflight passed — settings.json would be updated" : "✓ preflight passed — settings.json already current");
  console.log(log.join("\n"));
  process.exit(0);
}

if (changed) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${SETTINGS_PATH}.bak-${stamp}`;
  const temp = `${SETTINGS_PATH}.tmp-${process.pid}`;
  copyFileSync(SETTINGS_PATH, backup);
  writeFileSync(temp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(temp, SETTINGS_PATH);
  log.push(`✓ settings.json updated (backup: ${backup})`);
} else {
  log.push("✓ settings.json already current — no write");
}

// 3) Enforce mode 0600.
const mode = statSync(SETTINGS_PATH).mode & 0o777;
if (mode !== 0o600) {
  chmodSync(SETTINGS_PATH, 0o600);
  log.push(`✓ chmod 0${mode.toString(8)} → 0600`);
} else {
  log.push("= mode already 0600");
}

console.log(log.join("\n"));
