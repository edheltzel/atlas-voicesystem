# Voice compatibility path

This directory is the historical PAI stow path for atlas-voicesystem. The active architecture is now:

- Universal core: `../../../../../core/`
- PAI adapter: `../../../../../adapters/pai/`
- Pi adapter: `../../../../../adapters/pi/`
- Neutral scripts: `../../../../../scripts/`

`server.ts` in this directory is a compatibility entrypoint. It delegates to `core/server.ts` while preserving this directory's legacy PAI-specific `voices.json` and `pronunciations.json` for existing installations.

For current documentation, read the repo-root files:

- `README.md`
- `AGENTS.md`
- `MIGRATIONS.md`
- `docs/install-human.md`
- `docs/install-agent.md`
- `docs/development.md`
- `docs/dependencies.md`
