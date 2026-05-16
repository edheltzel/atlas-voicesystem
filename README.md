# atlas-voicesystem

Standalone, multi-provider TTS notification server with PAI integration. Lives outside `~/.claude/` so it survives upstream PAI updates; symlinked into `~/.claude/PAI/USER/Voice/` via GNU Stow.

## Architecture (short version)

- **server.ts** — Bun daemon on port 8888 with provider chain: edge-tts → elevenlabs → kokoro → say. Per-provider circuit breakers. Free-tier resilient (falls through 402s to next provider, ends at `say` floor).
- **voices.json** — single source of truth for provider config + per-agent voice mappings.
- **pronunciations.json** — word-boundary regex replacements (Kai → Kye, PAI → pie, ISC → I S C).
- **hooks/** — PAI session lifecycle integration: VoiceGate (subagent flood protection), VoiceGreeting (SessionStart catchphrase), VoiceNotification (Stop-phase 🗣️ speaker).
- **LaunchAgent** at `~/Library/LaunchAgents/com.pai.voice-server.plist` (created by `install.sh`).

## Stow layout

```
~/Developer/atlas-voicesystem/        ← project root (this repo)
├── README.md                          ← project docs (not stowed)
├── MIGRATIONS.md                      ← PAI-core edits to re-apply after upstream updates
└── claudecode/                        ← Stow package
    └── .claude/PAI/USER/Voice/        ← live voice system (real files)
```

Stow into home: `cd ~/Developer/atlas-voicesystem && stow -v -t ~ claudecode`
Unstow: `stow -v -t ~ -D claudecode`

After stow, `~/.claude/PAI/USER/Voice` is a directory symlink pointing here.

## Operation

```bash
# Install LaunchAgent (run from the canonical path so plist references real paths)
bash ~/Developer/atlas-voicesystem/claudecode/.claude/PAI/USER/Voice/install.sh

# Health
curl http://localhost:8888/health | jq

# Speak
curl -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello"}'

# Stop / Start / Restart
bash ~/.claude/PAI/USER/Voice/{stop,start,restart,status}.sh
```

## Patches applied (vs. original backup)

1. **server.ts:143-147** — added `~/.config/PAI/.env` to env-search paths (PAI v5+ env location).
2. **server.ts:455-460** — tightened `escapeForAppleScript` to also collapse newlines/returns/tabs (RedTeam PT-1: AppleScript injection defense).
3. **hooks/handlers/VoiceNotification.ts** — inlined the `ParsedTranscript` type that previously imported from `skills/PAI/Tools/TranscriptParser` (source no longer exists in current PAI).

See MIGRATIONS.md for the PAI-core integration edits that must be re-applied after every upstream PAI release.
