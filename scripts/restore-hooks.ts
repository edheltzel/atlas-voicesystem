#!/usr/bin/env bun
/** Compatibility wrapper for the PAI adapter hook-registration script. */
await import(new URL("../adapters/pai/restore-hooks.ts", import.meta.url).href);
