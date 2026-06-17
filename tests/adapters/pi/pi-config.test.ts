import { describe, expect, test } from "bun:test";
import { loadPiVoiceConfig, shouldSuppressVoice } from "../../../adapters/pi/config";

describe("Pi voice config", () => {
  test("uses safe defaults without host-specific settings", () => {
    const config = loadPiVoiceConfig({});
    expect(config.endpoint).toBe("http://localhost:8888/notify");
    expect(config.title).toBe("Pi Notification");
    expect(config.catchphrase).toBe("Pi session ready.");
    expect(config.voiceEnabled).toBe(true);
  });

  test("suppresses headless run modes (Pi subagents run `pi --mode json -p`)", () => {
    expect(shouldSuppressVoice({ hasUI: false }, {})).toBe(true);
    expect(shouldSuppressVoice({ mode: "json" }, {})).toBe(true);
    expect(shouldSuppressVoice({ mode: "print" }, {})).toBe(true);
  });

  test("speaks in interactive run modes with a real UI", () => {
    expect(shouldSuppressVoice({ mode: "tui", hasUI: true }, {})).toBe(false);
    expect(shouldSuppressVoice({ mode: "rpc", hasUI: true }, {})).toBe(false);
  });

  test("supports emergency suppression regardless of run mode", () => {
    expect(shouldSuppressVoice({ mode: "tui", hasUI: true }, { ATLAS_VOICE_SUPPRESS: "true" })).toBe(true);
  });
});
