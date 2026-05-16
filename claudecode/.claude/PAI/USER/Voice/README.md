# VoiceServer

> Multi-provider TTS notification server for AI coding assistants.

A lightweight HTTP server that gives AI agents a voice. POST a message, hear it spoken. Works with any coding agent that can make HTTP requests — Claude Code, OpenCode, Gemini CLI, Cursor, or a simple `curl`.

---

## Quick Start

```bash
# Install as macOS LaunchAgent (starts on login)
bash ~/.claude/VoiceServer/install.sh

# Or run manually
bun run ~/.claude/VoiceServer/server.ts

# Test it
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello from VoiceServer"}'
```

---

## Architecture

```
                        Any HTTP Client
                    (hooks, scripts, curl)
                             │
                        POST /notify
                             │
                             ▼
                    ┌─────────────────┐
                    │   VoiceServer   │
                    │   (Bun, :8888)  │
                    ├─────────────────┤
                    │ Input Pipeline  │
                    │  ├─ Sanitize    │
                    │  ├─ Pronounce   │
                    │  └─ Emotion     │
                    ├─────────────────┤
                    │ Provider Chain  │
                    │  1. Kokoro      │──► Local TTS (port 8880)
                    │  2. ElevenLabs  │──► Cloud API
                    │  3. macOS say   │──► /usr/bin/say
                    ├─────────────────┤
                    │ Circuit Breaker │
                    │ Rate Limiter    │
                    └────────┬────────┘
                             │
                        /usr/bin/afplay
                             │
                          🔊 Audio
```

**Runtime:** [Bun](https://bun.sh/) — runs TypeScript directly, no build step, zero npm dependencies.

---

## API

### POST /notify

Primary endpoint. Speaks a message using the configured TTS provider chain.

```json
{
  "message": "Task complete — 3 files modified",
  "title": "PAI Notification",
  "voice_id": "kai",
  "voice_enabled": true,
  "voice_settings": {
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0.0,
    "speed": 1.0
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `message` | string | `"Task completed"` | Text to speak (max 500 chars, markdown stripped) |
| `title` | string | `"PAI Notification"` | macOS notification title |
| `voice_id` | string | identity voice | Agent name or ElevenLabs voice ID |
| `voice_enabled` | boolean | `true` | Set `false` for silent notification |
| `voice_settings` | object | *from voices.json* | Override TTS parameters (see Voice Settings Resolution) |

**Response:** `{"status": "success", "message": "Notification sent"}`

### POST /notify/personality

Compatibility shim — sends `message` only, no `voice_id`. Uses identity voice.

```json
{ "message": "Standing by" }
```

### POST /pai

Simple alias — accepts `title` + `message`, uses identity voice.

```json
{ "title": "PAI Assistant", "message": "Ready" }
```

### GET /health

Returns server status, provider health, circuit breaker state.

```json
{
  "status": "healthy",
  "port": 8888,
  "activeProvider": "kokoro",
  "providers": {
    "kokoro": { "enabled": true, "healthy": true },
    "elevenlabs": { "enabled": false, "healthy": false },
    "say": { "enabled": true, "healthy": true }
  },
  "fallbackOrder": ["kokoro", "elevenlabs", "say"],
  "pronunciation_rules": 4,
  "emotional_presets": 13,
  "circuit_breakers": {
    "kokoro": { "open": false, "failures": 0 },
    "elevenlabs": { "open": false, "failures": 0 }
  }
}
```

---

## TTS Provider Chain

VoiceServer uses a 3-tier provider chain with automatic fallback:

| Priority | Provider | Type | Quality | Requirements |
|----------|----------|------|---------|-------------|
| 1 | **Kokoro** | Local | Good | [Kokoro server](https://huggingface.co/hexgrad/Kokoro-82M) running on port 8880 |
| 2 | **ElevenLabs** | Cloud | Premium | `ELEVENLABS_API_KEY` in env |
| 3 | **macOS say** | System | Basic | macOS (always available) |

If the primary provider fails, VoiceServer automatically tries the next in the chain. Circuit breakers prevent repeated calls to a failing provider (1 failure → 60s cooldown, then retry).

### Voice Settings Resolution (3-tier)

1. **Caller pass-through** — If `voice_settings` is provided in the POST body, it's used directly
2. **voices.json lookup** — If `voice_id` matches an agent name or ElevenLabs ID, provider-specific settings from `voices.json` are used
3. **Defaults** — `stability: 0.5, similarity_boost: 0.75, style: 0.0, speed: 1.0`

---

## Configuration

### voices.json

Single source of truth for all voice configuration. Loaded once at startup.

```jsonc
{
  "providers": {
    "kokoro": {
      "enabled": true,
      "endpoint": "http://127.0.0.1:8880/v1",
      "defaultVoice": "af_sky"
    },
    "elevenlabs": {
      "enabled": false,
      "apiKey": "${ELEVENLABS_API_KEY}",
      "defaultVoiceId": "s3TPKV1kjDlVtZbl4Ksh"
    },
    "say": {
      "enabled": true,
      "voice": "Daniel (Enhanced)"
    }
  },
  "defaultProvider": "kokoro",
  "fallbackOrder": ["kokoro", "elevenlabs", "say"],
  "default_rate": 175,       // macOS say words-per-minute
  "default_volume": 0.8,     // afplay volume (0.0-1.0)

  "identity": {              // Default voice (when no voice_id specified)
    "description": "Main AI assistant voice (Atlas)",
    "kokoro": { "voice": "af_heart", "speed": 1.1 },
    "elevenlabs": { "voice_id": "...", "stability": 0.35 }
  },

  "agents": {                // Named agent voices
    "kai": {
      "description": "UK Male - Expressive eager buddy",
      "catchphrase": "Kai here, let's do this!",
      "kokoro": { "voice": "am_fenrir", "speed": 1.1 },
      "elevenlabs": { "voice_id": "...", "stability": 0.5 }
    }
    // ... 14 named agents total
  }
}
```

**Agent voices:** `kai`, `perplexity-researcher`, `claude-researcher`, `gemini-researcher`, `engineer`, `architect`, `designer`, `artist`, `pentester`, `writer`, `intern`, `codex-researcher`, `grok-researcher`, `algorithm`, `qa-tester`.

### pronunciations.json

Word-boundary regex replacements applied before sending text to TTS. Fixes common mispronunciations.

```json
{
  "replacements": [
    { "term": "Kai", "phonetic": "Kye", "note": "Rhymes with sky, not lay" },
    { "term": "PAI", "phonetic": "pie", "note": "Personal AI Infrastructure" },
    { "term": "ISC", "phonetic": "I S C", "note": "Spell out" }
  ]
}
```

### Environment Variables

| Variable | Purpose | Location |
|----------|---------|----------|
| `ELEVENLABS_API_KEY` | ElevenLabs API authentication | `~/.claude/.env` or `~/.env` (first found wins) |
| `PORT` | Server port | Default: `8888` |

---

## Emotional Presets

Messages can include emoji markers that adjust voice tone via stability/similarity_boost overlays:

| Marker | Emotion | Effect |
|--------|---------|--------|
| `[💥 excited]` | High energy | stability: 0.70, boost: 0.90 |
| `[🎉 celebration]` | Celebratory | stability: 0.65, boost: 0.85 |
| `[💡 insight]` | Discovery | stability: 0.55, boost: 0.80 |
| `[🎨 creative]` | Creative | stability: 0.50, boost: 0.75 |
| `[✨ success]` | Achievement | stability: 0.60, boost: 0.80 |
| `[📈 progress]` | Progress | stability: 0.55, boost: 0.75 |
| `[🔍 investigating]` | Analytical | stability: 0.60, boost: 0.85 |
| `[🐛 debugging]` | Problem-solving | stability: 0.55, boost: 0.80 |
| `[📚 learning]` | Contemplative | stability: 0.50, boost: 0.75 |
| `[🤔 pondering]` | Thoughtful | stability: 0.65, boost: 0.80 |
| `[🎯 focused]` | Precise | stability: 0.70, boost: 0.85 |
| `[⚠️ caution]` | Warning | stability: 0.40, boost: 0.60 |
| `[🚨 urgent]` | Critical | stability: 0.30, boost: 0.90 |

Markers are stripped from spoken text before TTS. Example:
```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "[💡 insight] Found the root cause — race condition in the event loop"}'
```

---

## Circuit Breakers

Each cloud provider (Kokoro, ElevenLabs) has an independent circuit breaker:

- **Threshold:** 1 failure opens the circuit
- **Cooldown:** 60 seconds before retrying
- **States:** Closed (normal) → Open (failed, skip) → Half-Open (testing recovery)
- **Recovery:** Automatic on next successful call after cooldown

This prevents wasting time on a dead provider. If Kokoro's local server is down, VoiceServer immediately falls through to ElevenLabs or macOS say without waiting for timeouts on every request.

---

## Rate Limiting & Security

- **Rate limit:** 10 requests per 60 seconds per IP
- **CORS:** Restricted to `http://localhost`
- **Input sanitization:** Strips markdown, shell metacharacters, `<script>` tags
- **Message limit:** 500 characters max
- **AppleScript escaping:** All notification text is escaped before osascript execution
- **Localhost only:** Server binds to localhost, not accessible from network

---

## Process Lifecycle

### macOS LaunchAgent (recommended)

```bash
# Install — creates ~/Library/LaunchAgents/com.pai.voice-server.plist
bash ~/.claude/VoiceServer/install.sh

# Lifecycle
bash ~/.claude/VoiceServer/start.sh      # Load LaunchAgent
bash ~/.claude/VoiceServer/stop.sh       # Unload + kill port 8888
bash ~/.claude/VoiceServer/restart.sh    # Stop then start
bash ~/.claude/VoiceServer/status.sh     # Check service + health
bash ~/.claude/VoiceServer/uninstall.sh  # Remove LaunchAgent entirely
```

**LaunchAgent behavior:**
- `RunAtLoad: true` — starts automatically on login
- `KeepAlive.SuccessfulExit: false` — restarts on crash, not on clean exit
- Logs: `~/Library/Logs/pai-voice-server.log`

### Manual

```bash
bun run ~/.claude/VoiceServer/server.ts
```

### Menubar Plugin

Optional SwiftBar/BitBar plugin that shows VoiceServer health in the macOS menu bar:

```bash
bash ~/.claude/VoiceServer/menubar/install-menubar.sh
```

Polls `GET /health` every 5 seconds, shows provider status.

---

## Integration with Coding Agents

VoiceServer is **agent-agnostic** — any process that can POST JSON to `localhost:8888` can use it. The API has zero agent-specific concepts.

### Generic Integration (any agent)

Add a voice notification to your agent's workflow:

```bash
# Simplest possible integration — one curl command
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Task complete"}'
```

### Claude Code Integration

Claude Code uses [hooks](../hooks/README.md) to integrate with VoiceServer at several lifecycle points:

| Hook | Event | What It Does |
|------|-------|-------------|
| `VoiceGreeting.hook.ts` | SessionStart | Speaks startup catchphrase ("Atlas, standing by") |
| `VoiceGate.hook.ts` | PreToolUse (Bash) | Blocks subagent voice curls (prevents flooding) |
| `VoiceNotification.ts` | Stop (via StopOrchestrator) | Speaks the `🗣️` completion line |
| `UpdateTabTitle.hook.ts` | UserPromptSubmit | Announces prompt summary |
| `AlgorithmTracker.hook.ts` | PostToolUse | Announces rework transitions |

**Subagent protection:** VoiceGate prevents agent swarms from flooding VoiceServer. Only the primary session can POST to `:8888`. The `PAI_SUPPRESS_VOICE` environment variable suppresses voice in spawned `claude -p` processes.

### Adding VoiceServer to Another Agent

To integrate with a different coding agent (OpenCode, Gemini CLI, Cursor, etc.):

1. **Ensure VoiceServer is running** — `bash ~/.claude/VoiceServer/status.sh`
2. **POST notifications from your agent's hooks or scripts** — use the `/notify` endpoint
3. **Optionally register a voice identity** — add an entry to `voices.json` under `agents`
4. **Handle rate limiting** — 10 req/60s per IP, plan accordingly for multi-agent setups

No VoiceServer code changes needed. The server doesn't know or care what agent is calling it.

---

## File Structure

```
VoiceServer/
├── server.ts              ← Main server (Bun, ~1125 lines)
├── voices.json            ← Voice + provider configuration
├── pronunciations.json    ← TTS pronunciation overrides
├── README.md              ← This file
├── install.sh             ← Install as macOS LaunchAgent
├── uninstall.sh           ← Remove LaunchAgent
├── start.sh               ← Start service
├── stop.sh                ← Stop service
├── restart.sh             ← Restart service
├── status.sh              ← Check service status
├── logs/
│   ├── voice-server.log       ← stdout
│   └── voice-server-error.log ← stderr
└── menubar/
    ├── pai-voice.5s.sh        ← SwiftBar/BitBar plugin
    └── install-menubar.sh     ← Menubar installer
```

---

## Logs & Debugging

| Source | Path | What It Shows |
|--------|------|---------------|
| **Server log** | `~/Library/Logs/pai-voice-server.log` | TTS requests, provider selection, errors |
| **Server errors** | `VoiceServer/logs/voice-server-error.log` | Crash traces |
| **Voice events** | `~/.claude/MEMORY/VOICE/voice-events.jsonl` | Voice notification history (written by hooks) |
| **Hook debug** | `~/.claude/MEMORY/HOOKS/hook-debug.jsonl` | Hook decisions (VoiceGreeting, VoiceGate) |

```bash
# Live tail server activity
tail -f ~/Library/Logs/pai-voice-server.log

# Check health
curl -s http://localhost:8888/health | jq .

# Check if running
bash ~/.claude/VoiceServer/status.sh
```

---

## Troubleshooting

| Problem | Check | Fix |
|---------|-------|-----|
| No sound | `status.sh` shows not running | `start.sh` |
| Wrong voice | `voice_id` not in voices.json | Add agent entry or use identity default |
| Kokoro failing | Kokoro server not on port 8880 | Start Kokoro, or disable in voices.json |
| ElevenLabs 401 | API key missing or invalid | Set `ELEVENLABS_API_KEY` in `~/.claude/.env` |
| Rate limited | Too many requests | Wait 60s, or increase `RATE_LIMIT` in server.ts |
| Voice repeating | Duplicate hook fires | Check hook dedup (PID, source, PAI_SUPPRESS_VOICE) |
| Recursive processes | `claude -p` spawning hooks | Ensure recursion guards (SESSION_EXTRACT_ACTIVE) |

---

*VoiceServer is part of [Atlas Config](../../../README.md) — Personal AI Infrastructure.*
