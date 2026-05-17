# AGENTS.md

> Single source of truth for any AI agent (Claude, Pi, OpenCode, etc.) working on this repository. Humans benefit too — but the structure is optimized for agents that need to act correctly on first read without prior context.

---

## 1. What this repo is

`atlas-voicesystem` is a standalone, multi-provider TTS notification server. A Bun daemon on `localhost:8888` accepts POSTed JSON messages and speaks them through a configurable provider chain (edge-tts → ElevenLabs → Kokoro → macOS `say`).

It currently ships with PAI-specific hooks bundled in `claudecode/.claude/PAI/USER/Voice/hooks/`, but the architectural direction (tracked in [issue #1](https://github.com/edheltzel/atlas-voicesystem/issues/1)) is to **decouple from PAI entirely** and make the server a universal voice-notification primitive that any coding agent, terminal, script, or future harness consumes through a thin adapter package.

**Status:** v0.1 working installation; pre-decoupling. See **§14 Roadmap** for the next moves.

---

## 2. Read this first

| If you want to… | Read |
|---|---|
| Understand the current state | This file, then `README.md` |
| Understand what changed during the recent investigation | `README.md` → "Investigation log" |
| Re-apply PAI-core edits after a PAI upgrade | `MIGRATIONS.md` |
| Touch the daemon | `claudecode/.claude/PAI/USER/Voice/server.ts` |
| Add or rename an agent voice | `claudecode/.claude/PAI/USER/Voice/voices.json` |
| Fix a TTS mispronunciation | `claudecode/.claude/PAI/USER/Voice/pronunciations.json` |
| Pick up planned work | [GitHub issues](https://github.com/edheltzel/atlas-voicesystem/issues) |

---

## 3. Quick reference

### Paths

| Purpose | Path |
|---|---|
| Repo root | `~/Developer/atlas-voicesystem/` |
| Stow package | `~/Developer/atlas-voicesystem/claudecode/` |
| Canonical server source | `claudecode/.claude/PAI/USER/Voice/server.ts` |
| Live (symlinked) location | `~/.claude/PAI/USER/Voice/` → repo |
| LaunchAgent plist | `~/Library/LaunchAgents/com.pai.voice-server.plist` |
| Server log | `~/Library/Logs/pai-voice-server.log` |
| Env (searched in order) | `~/.config/PAI/.env` → `~/.claude/.env` → `~/.env` |
| Diagnostic log (if patched) | `~/.claude/PAI/MEMORY/VOICE/voice-callers.jsonl` |

### Ports

| Port | Service |
|---|---|
| `8888` | atlas-voicesystem (this server) |
| `8880` | Kokoro local TTS (optional, off by default) |
| `31337` | PAI Pulse (separate process, voice module disabled) |

### Commands

```bash
# Health
curl http://localhost:8888/health | jq

# Speak
curl -X POST http://localhost:8888/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello"}'

# Lifecycle (after install)
~/.claude/PAI/USER/Voice/start.sh
~/.claude/PAI/USER/Voice/stop.sh
~/.claude/PAI/USER/Voice/restart.sh
~/.claude/PAI/USER/Voice/status.sh

# Reload (after editing server.ts)
launchctl kickstart -k "gui/$UID/com.pai.voice-server"
tail -f ~/Library/Logs/pai-voice-server.log
```

---

## 4. Architecture deep dive

### Daemon

`server.ts` (~1.3k lines) is a single-process Bun HTTP server. Concerns inside:

- **Provider abstraction** — `TTSProvider` interface with `isEnabled() / isHealthy() / speak()`. Implementations: `EdgeTTSProvider`, `ElevenLabsProvider`, `KokoroProvider`, `MacOSSayProvider`.
- **Provider chain** — `speakWithFallback()` iterates `defaultProvider` then the rest of `fallbackOrder`. First success wins. Per-provider **circuit breaker** opens after 1 failure, cools down 60s.
- **Voice config** — `voices.json` defines providers, fallback order, default audio settings, the assistant identity voice, and a dictionary of named agent voices (kai, perplexity-researcher, engineer, architect, designer, artist, pentester, etc.). 3-tier resolution: caller-provided `voice_settings` → matched agent mapping → defaults.
- **Pronunciation preprocessing** — `pronunciations.json` defines word-boundary regex replacements (`Kai → Kye`, `PAI → pie`, `ISC → I S C`). Applied before synthesis.
- **Emotional presets** — 13 emoji-tagged emotion overlays (`[💡 insight]`, `[🎯 focused]`, `[🚨 urgent]`, etc.) that modify `stability` + `similarity_boost`.
- **Endpoints** — `POST /notify`, `POST /notify/personality`, `POST /pai`, `GET /health`. (See §7 HTTP API.)
- **Safety** — Input length cap 500 chars, sanitization strips script tags / shell metachars, AppleScript escaping collapses newlines (RedTeam PT-1 defense), rate limit 10 req/60s per source IP, CORS restricted to localhost.
- **Audio playback** — `afplay` on macOS (single-device serialization is natural concurrency control).
- **Structured logging** — `[req-N-base36] session=... source=... <message>` to stdout/stderr, captured by LaunchAgent into the log file.

### Hooks (current — being decoupled)

The PAI integration lives at `claudecode/.claude/PAI/USER/Voice/hooks/`:

| Hook | PAI lifecycle | Purpose |
|---|---|---|
| `VoiceGate.hook.ts` | PreToolUse (Bash) | Block subagent voice curls; only main session may POST `/notify` |
| `VoiceGreeting.hook.ts` | SessionStart `source=startup` | Speak the catchphrase at session start; route named-agent greetings |
| `handlers/VoiceNotification.ts` | Stop (called from PAI core hook) | Speak the response 🗣️ line |

These hooks read PAI's `settings.json`, `agents/`, and `MEMORY/STATE/current-work.json`. Per [issue #1](https://github.com/edheltzel/atlas-voicesystem/issues/1) they will move to `adapters/pai/` and the server itself will gain no new PAI knowledge.

### Helpers (lib/)

`hooks/lib/` contains shared utilities used by the PAI hooks. They are **inherited from PAI**, intentionally **duplicated** here so the repo is self-contained:

- `paths.ts` — `paiPath()`, `~/.claude/PAI/...` resolvers
- `identity.ts` — read DA identity from PAI `settings.json`
- `output-validators.ts` — validate voice completion strings (length, profanity floor, fallback)
- `hook-logger.ts` — structured hook diagnostics
- `time.ts` — ISO timestamp helpers

When the PAI adapter is extracted, these move with it. The bare server has no `lib/`.

### Menubar (optional)

`menubar/pai-voice.5s.sh` is an xbar/BitBar plugin that polls `/health` every 5s and renders a colored dot in the macOS menu bar. `menubar/install-menubar.sh` installs it. Skip unless explicitly requested.

---

## 5. Distribution model

The repo uses **GNU Stow** to symlink the canonical files into the user's home:

```
~/Developer/atlas-voicesystem/         ← this repo
├── README.md                          ← project docs (not stowed)
├── AGENTS.md                          ← this file (not stowed)
├── CLAUDE.md                          ← (not stowed, one-line redirect)
├── MIGRATIONS.md                      ← PAI-core re-application notes (not stowed)
└── claudecode/                        ← stow package
    └── .claude/PAI/USER/Voice/        ← real files live here
        ├── server.ts
        ├── voices.json
        ├── pronunciations.json
        ├── install.sh / start.sh / stop.sh / restart.sh / status.sh / uninstall.sh
        ├── hooks/
        │   ├── VoiceGate.hook.ts
        │   ├── VoiceGreeting.hook.ts
        │   ├── handlers/VoiceNotification.ts
        │   └── lib/{paths,identity,output-validators,hook-logger,time}.ts
        └── menubar/
            ├── pai-voice.5s.sh
            └── install-menubar.sh
```

Stow into home:

```bash
cd ~/Developer/atlas-voicesystem && stow -v -t ~ claudecode
```

After stow, `~/.claude/PAI/USER/Voice` is a directory symlink pointing into this repo. Edits made through either path land in the same file.

Unstow: `cd ~/Developer/atlas-voicesystem && stow -v -t ~ -D claudecode`

---

## 6. Provider chain

Configured in `voices.json`. Default order: `edgetts → elevenlabs → kokoro → say`.

| Provider | Cost | Quality | Required setup | Default state |
|---|---|---|---|---|
| **edge-tts** | free | high | `pip3 install edge-tts` at `/opt/homebrew/bin/python3` | ✅ enabled |
| **ElevenLabs** | paid | premium | `ELEVENLABS_API_KEY` in `.env`; library voices need paid tier (free returns 402) | ⬚ disabled by default |
| **Kokoro** | free | high | Local Kokoro server on `127.0.0.1:8880` | ⬚ disabled by default (server not running on most installs) |
| **macOS `say`** | free | basic | nothing — always available on macOS | ✅ enabled (terminal fallback) |

Per-provider circuit breakers prevent a single failing provider from delaying every request — one failure trips the breaker, fallback chain advances immediately, 60 s cooldown before re-test.

---

## 7. HTTP API

All endpoints accept JSON, CORS-restricted to `http://localhost`, rate-limited to 10 req/60 s/IP.

### `POST /notify`

Primary endpoint. Body:

```json
{
  "title": "PAI Notification",
  "message": "Hello",
  "voice_enabled": true,
  "voice_id": "Ioq2c1GJee5RyqeoBIH3",
  "voice_settings": {
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0.0,
    "speed": 1.0,
    "use_speaker_boost": true
  },
  "session_id": "...",
  "source": "claude-code"
}
```

All fields are optional except `message`. Pass `voice_enabled: false` to display the macOS notification banner without speaking.

### `POST /notify/personality`

Compatibility shim for legacy callers. Same body, calls the same path internally.

### `POST /pai`

Compatibility shim for older PAI invocations.

### `GET /health`

Returns JSON with port, default provider, fallback order, per-provider enabled/healthy status, circuit-breaker state, pronunciation rule count, and emotional preset count. Use this in tooling to detect "is the server up?".

### Future: WebSocket / streaming

Not currently supported. May arrive with the universalization work (issue #1).

---

## 8. Configuration

### `voices.json`

Single source of truth for provider config and named-agent voice mappings. Edit-and-restart workflow; no live reload.

- `providers.{edgetts,elevenlabs,kokoro,say}` — provider toggles + per-provider defaults (voice id, endpoint, api key reference).
- `defaultProvider` — first attempted.
- `fallbackOrder` — order after default.
- `default_rate`, `default_volume` — global audio settings.
- `identity` — the assistant's main voice (Atlas).
- `agents` — dictionary of named-agent voice mappings (kai, engineer, architect, designer, artist, pentester, writer, intern, researcher variants, etc.). Each may define `elevenlabs`, `kokoro`, and `catchphrase`.

### `pronunciations.json`

Word-boundary regex replacements applied before synthesis. Example: `Kai → Kye` (rhymes with sky, not lay).

### `.env`

Loaded in priority order from `~/.config/PAI/.env`, `~/.claude/.env`, `~/.env`. First found wins per key. Used for `ELEVENLABS_API_KEY` and any other provider secrets.

---

## 9. Conventions (must follow)

| Rule | Why |
|---|---|
| **Bun only** — never `npm`, `npx`, `node` | Repo is Bun-native; mixing produces silent breakage |
| **TypeScript strict mode** | Caught by `tsc --noEmit` checks; PRs that loosen strictness will be rejected |
| **All work on `dev` branch** | `master` is protected by local pre-push hook. Versioned at `.githooks/pre-push`; install with `git config core.hooksPath .githooks` after cloning |
| **Conventional commits** | `feat:`, `fix:`, `docs:`, `refactor:`, `chore:` etc. |
| **PR from `dev` → `master`** for releases | `gh pr create --base master --head dev` |
| **No PAI imports in `server.ts`** | Server is being universalized; new PAI knowledge belongs in `adapters/pai/` (after issue #1 lands) |
| **No state in `/tmp`** | World-writable; use `~/Library/Logs/`, `~/.config/PAI/`, or a repo-local path |
| **Don't break the `/notify` contract** | Many callers depend on the existing body shape and 200/400/500 semantics |
| **Restart with `launchctl kickstart -k gui/$UID/com.pai.voice-server`** after server.ts edits | LaunchAgent re-execs the new file |

---

## 10. Development workflow

```bash
# 1. Clone (already done if you're reading this in-repo)
cd ~/Developer/atlas-voicesystem
git checkout dev

# 2. Make changes
$EDITOR claudecode/.claude/PAI/USER/Voice/server.ts

# 3. Restart the running server with new code
launchctl kickstart -k "gui/$UID/com.pai.voice-server"

# 4. Watch the log
tail -f ~/Library/Logs/pai-voice-server.log

# 5. Smoke-test silently
curl -s -X POST http://localhost:8888/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"smoke","voice_enabled":false}'

# 6. Commit + push
git add -A
git commit -m "feat: short imperative description"
git push origin dev

# 7. When ready to release
gh pr create --base master --head dev --title "..." --body "..."
```

**Note:** No automated test suite exists yet (tracked in issue #3). For now: edit, restart, curl, listen.

---

## 11. PAI integration (current state)

Today, this repo ships PAI integration as part of the same tree. The hooks read PAI's `settings.json`, identity files, and memory state. PAI core has been edited in 12+ files to point at `localhost:8888/notify` — those edits are listed in `MIGRATIONS.md` and **must be re-applied after every upstream PAI release**.

This is the wrong architecture going forward. Issue #1 separates concerns so:

- `server.ts` knows nothing about PAI, Pi, or any specific host
- PAI-specific behavior lives in `adapters/pai/`
- Pi-specific behavior lives in `adapters/pi/` (issue #7)
- Hosts opt in by installing the relevant adapter package

Until issue #1 lands, do not add new PAI-specific code to `server.ts`. Use the existing hooks pattern or wait for the refactor.

---

## 12. Gotchas / non-obvious behavior

1. **`~/.claude/PAI/USER/Voice` is a SYMLINK** to this repo (`stow` does it). Edits to either path modify the same file. Confirm with `ls -la ~/.claude/PAI/USER/`.
2. **edge-tts requires Python at `/opt/homebrew/bin/python3`** with `edge_tts` installed. If you change the Python path, edit `server.ts:559` (`PYTHON3_PATH` constant).
3. **ElevenLabs free tier returns 402 for library voices.** The fallback chain handles this gracefully; don't be surprised if voices.json defaults skip ElevenLabs.
4. **`afplay` serializes audio naturally** — concurrent /notify calls do not overlap; they queue at the OS audio layer. This is the "feature" that masked our zombie-voice investigation for years.
5. **Voice-events.jsonl logs `voice_engine: "elevenlabs"` regardless of actual provider.** This is a stale hardcoded string in `hooks/handlers/VoiceNotification.ts`'s logging code — not evidence ElevenLabs was called. The actual provider is in the server log.
6. **Rate limit is per `x-forwarded-for` header**, falling back to literal `"localhost"`. Two callers from the same IP share the 10 req/60s budget.
7. **The LaunchAgent plist references absolute paths** to `~/Developer/atlas-voicesystem/...`. If you move the repo, run `install.sh` again to regenerate the plist.
8. **MIGRATIONS.md is fragile** — every PAI upgrade may clobber the 12+ files listed there. After an upgrade, run the combined re-apply script at the bottom of MIGRATIONS.md.
9. **Pulse on `:31337` is still running** but its voice module is disabled via `PULSE.toml`. Don't accidentally re-enable it; it competes for `/notify`.
10. **Branch protection on master is local-only** (private repo can't use GitHub branch protection on the free tier). The `.git/hooks/pre-push` hook blocks direct pushes from this machine. Other contributors or other machines need to install the hook themselves until the repo goes public or upgrades to Pro.

---

## 13. Recent investigation summary (2026-05-16)

After migrating from the (silently failing) Pulse → ElevenLabs path to the working edge-tts server, voice appeared to fire during inactivity. Hypothesis: race / zombie sessions.

**Method:** Behavior-neutral diagnostic patch added to `server.ts` resolved every caller's PID + ancestry chain via `lsof + ps`. Stress test: 4 parallel claude sessions spawned in a herdr workspace. Result: 4 SessionStart greetings fired within **315 ms**, `afplay` serialized them across 4.6 s of wall clock, no race, no drops. The only `ppid:1` orphan caller observed was the legitimate Pulse `CostTracker.ts` cron.

**Conclusion:** No race condition. The "voice with no session" perception is two real, separable, non-bug things:

1. **Autonomous Pulse cron voice** (cost alerts, DA morning brief) — fires by design with no session.
2. **Per-instance startup greeting** — every fresh `claude` window legitimately greets, so N background windows = N greetings. Previously masked by ElevenLabs failures; now audible.

The architecture is sound. Open work is about *fit* (universal voice server) and *ergonomics* (presence detection, debounce, configurability), not correctness. See `README.md` for the full investigation log.

---

## 14. Roadmap

Tracked as GitHub issues. Pick up in dependency order:

| # | Issue | Theme |
|---|---|---|
| [1](https://github.com/edheltzel/atlas-voicesystem/issues/1) | Decouple voice server from PAI — extract host-specific code into an adapter pattern | foundational |
| [2](https://github.com/edheltzel/atlas-voicesystem/issues/2) | Document the dependency graph — required vs. optional third-party systems | docs |
| [3](https://github.com/edheltzel/atlas-voicesystem/issues/3) | Add local dev / testing / installation documentation | docs |
| [4](https://github.com/edheltzel/atlas-voicesystem/issues/4) | Separate install/config docs — humans vs. AI agents | docs |
| [5](https://github.com/edheltzel/atlas-voicesystem/issues/5) | Contribution guidelines | docs |
| [6](https://github.com/edheltzel/atlas-voicesystem/issues/6) | Investigate `vp` for local dev workflow | spike |
| [7](https://github.com/edheltzel/atlas-voicesystem/issues/7) | Build pi-extension (first non-PAI adapter, depends on #1) | new adapter |
| [8](https://github.com/edheltzel/atlas-voicesystem/issues/8) | NPM package for one-command install (depends on #7) | packaging |

Every issue has a `## For Humans` and a `## For AI Agents` section. Pick the one that matches you.

---

## 15. For AI agents — explicit checklists

### Before you edit anything

1. Confirm you're on `dev`: `git branch --show-current`
2. Confirm `~/.claude/PAI/USER/Voice` is a symlink to this repo: `ls -la ~/.claude/PAI/USER/ | grep Voice` should show `-> .../atlas-voicesystem/...`
3. Confirm the server is running: `curl -fsS http://localhost:8888/health | head -c 80`
4. Read this file (you're doing that). Then read the relevant code file from §3 paths.

### When you change `server.ts`

1. Edit the file directly (it's a TypeScript file but Bun runs it without compilation).
2. Restart: `launchctl kickstart -k "gui/$UID/com.pai.voice-server"`
3. Tail log: `tail -f ~/Library/Logs/pai-voice-server.log`
4. Smoke-test silently: `curl -s -X POST http://localhost:8888/notify -H 'Content-Type: application/json' -d '{"message":"test","voice_enabled":false}'`
5. Expected: response `{"status":"success",...}` within 1 s, no errors in log.

### When you change `voices.json` or `pronunciations.json`

These are loaded at startup only. Same restart sequence as above. Verify the new config reflected at `GET /health`.

### When you change a hook

Hooks are PAI-specific and run per Claude session event. To test:
1. Open a fresh `claude` session in a separate terminal (or in a herdr pane).
2. The hook fires automatically. Watch `~/Library/Logs/pai-voice-server.log` for the matching request.
3. For VoiceGate (PreToolUse): trigger a Bash command in the session.
4. For VoiceGreeting (SessionStart): just open the session.
5. For VoiceNotification (Stop, in PAI core): wait for a response to complete.

### When you commit

1. Conventional-commit prefix (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`).
2. Subject ≤ 72 chars. Body explains *why*, not *what*.
3. Push to `dev`: `git push origin dev`.
4. **Never `git push origin master` directly.** The local pre-push hook will reject it. To release: `gh pr create --base master --head dev`.

### Things you must NOT do

- ❌ Import from PAI in `server.ts` or `voices.json`. Server stays host-agnostic.
- ❌ Write process state to `/tmp`. World-writable.
- ❌ Add new `localhost:31337` references. Old Pulse port; everything is `:8888`.
- ❌ Change the `/notify` request/response shape without bumping a compatibility version.
- ❌ Disable rate limiting or CORS without a documented threat-model update.
- ❌ Commit `.env` or any file containing real API keys.
- ❌ Edit `claudecode/.claude/PAI/USER/Voice/` files via `~/.claude/PAI/USER/Voice/` and expect them to be in a different place. It's a symlink.
- ❌ Push to `master`. Always PR from `dev`.

### Things you should do

- ✅ Use Bun for everything. `bun run`, `bun install`, `bun test` (when tests exist).
- ✅ Use the existing logging — `log('info' | 'warn' | 'error', message, ctx)` with a `LogContext`.
- ✅ When adding a feature, also add a `/health` field that surfaces its status.
- ✅ When adding a new provider, implement the `TTSProvider` interface and register in `providers` object near line 862 of `server.ts`. Add a circuit breaker entry.
- ✅ When adding a new agent voice, edit `voices.json` `agents.<name>` with at least one of `elevenlabs` or `kokoro`.
- ✅ When fixing a bug, include a smoke-test command in the commit body.
- ✅ When in doubt, file a GitHub issue and link it from your PR.

---

## 16. Provenance

- Origin: extracted from PAI `~/.claude/PAI/USER/Voice/` on 2026-05-15, then symlinked back via `stow` (see `MIGRATIONS.md`).
- Owner: `@edheltzel`.
- License: TBD (see issue #5 for CONTRIBUTING + LICENSE).
- Adjacent repos: PAI (host), Pi (forthcoming host, issue #7), OpenCode (mentioned in `server.ts` TODOs).
