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

  test("suppresses known Pi subagent environments", () => {
    expect(shouldSuppressVoice({ PI_SUBAGENT_CHILD: "1" })).toBe(true);
    expect(shouldSuppressVoice({ PI_SUBAGENT_FANOUT_CHILD: "1" })).toBe(true);
    expect(shouldSuppressVoice({ PI_SUBAGENT_PARENT_RUN_ID: "run-1" })).toBe(true);
  });

  test("supports emergency suppression", () => {
    expect(shouldSuppressVoice({ ATLAS_VOICE_SUPPRESS: "true" })).toBe(true);
  });
});
