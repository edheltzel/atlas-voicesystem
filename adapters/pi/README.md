# Pi Adapter

Pi host adapter for atlas-voicesystem.

The adapter is a Pi package. It listens to Pi lifecycle events and translates them into `/notify` requests against the local voice server.

## Install locally

```bash
pi install ./adapters/pi
```

Or let the repository installer do it:

```bash
bash scripts/install.sh --adapter pi
```

## Behavior

- `session_start` → speaks a greeting once for user-visible session starts.
- `message_end` / `turn_end` → extracts the final `🗣️` line from assistant text and speaks it once.
- Headless run modes are suppressed: Pi spawns subagents as `pi --mode json -p`, which report `ctx.hasUI === false`. Voice fires only when a real UI is present (`tui`/`rpc`). Set `ATLAS_VOICE_SUPPRESS=true` to force-mute any context.

## Configuration

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `ATLAS_VOICE_NOTIFY_URL` | `http://localhost:8888/notify` | Core notify endpoint |
| `ATLAS_VOICE_TITLE` | `Pi Notification` | Notification title |
| `ATLAS_VOICE_CATCHPHRASE` | `Pi session ready.` | Session-start greeting |
| `ATLAS_VOICE_ID` | unset | Optional voice mapping/id |
| `ATLAS_VOICE_ENABLED` | `true` | Set `false` for silent notifications |
| `ATLAS_VOICE_GREET_ON_START` | `true` | Enable/disable greetings |
| `ATLAS_VOICE_SPEAK_COMPLETIONS` | `true` | Enable/disable `🗣️` completion speech |
| `ATLAS_VOICE_SUPPRESS_SUBAGENTS` | `true` | Suppress Pi subagent voices |
| `ATLAS_VOICE_SUPPRESS` | `false` | Global emergency suppression |

## Status command

Inside Pi:

```text
/voice-status
```
