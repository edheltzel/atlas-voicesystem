#!/usr/bin/env bun
/**
 * Compatibility entrypoint for the historical PAI stow path.
 *
 * The universal server now lives at core/server.ts. This wrapper keeps existing
 * LaunchAgent plists and PAI installs working while the repository migrates to
 * the host-adapter layout.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

process.env.VOICES_PATH ??= join(here, "voices.json");
process.env.PRONUNCIATIONS_PATH ??= join(here, "pronunciations.json");
process.env.VOICESYSTEM_DEFAULT_TITLE ??= "PAI Notification";
process.env.VOICESYSTEM_ENV_PATHS ??= [
  join(homedir(), ".config", "PAI", ".env"),
  join(homedir(), ".claude", ".env"),
  join(homedir(), ".env"),
].join(":");

await import(new URL("../../../../../core/server.ts", import.meta.url).href);
