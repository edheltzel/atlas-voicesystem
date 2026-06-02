# Human Install Guide

This guide installs `atlas-voicesystem`, a local voice notification server for coding agents and scripts.

## What gets installed

The installer writes a macOS LaunchAgent for the universal core server and optionally registers one host adapter:

- **Core only** — any process can POST to `/notify`.
- **PAI adapter** — existing PAI lifecycle hooks continue to speak.
- **Pi adapter** — Pi session start and `🗣️` completion lines speak.

## Prerequisites

Install Bun first. Optional voice providers and host adapters are described in `docs/dependencies.md`.

## Install core only

```bash
bash scripts/install.sh --adapter none
```

This writes a neutral LaunchAgent (`com.atlas.voicesystem`) and starts the server on `localhost:8888`.

You should see a health success message. If not, open the log path printed by the script.

## Add the PAI adapter

```bash
bash scripts/install.sh --adapter pai
```

This installs the same core server and re-applies PAI hook registrations through `adapters/pai/restore-hooks.ts`.

## Add the Pi adapter

```bash
bash scripts/install.sh --adapter pi
```

This installs the core server, then registers `adapters/pi/` as a Pi package.

Inside Pi, `/voice-status` shows adapter configuration.

## Verify manually

```bash
curl -fsS http://localhost:8888/health
curl -fsS -X POST http://localhost:8888/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello from atlas voicesystem"}'
```

The second command should speak aloud unless your provider chain is disabled or muted.

## Uninstall

```bash
bash scripts/uninstall.sh
```

The uninstall script removes the neutral LaunchAgent but preserves logs and repo files.

## Development

For local development without disturbing the production service, use `docs/development.md`.
