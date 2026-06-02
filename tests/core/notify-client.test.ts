import { describe, expect, test } from "bun:test";
import { normalizeNotifyPayload } from "../../core/notify-client";

describe("notify client payload normalization", () => {
  test("preserves adapter metadata and removes undefined optional fields", () => {
    const payload = normalizeNotifyPayload({
      message: "Task complete",
      title: "Pi Notification",
      voice_enabled: true,
      voice_id: undefined,
      session_id: "session-1",
      source: "pi",
    });

    expect(payload).toEqual({
      message: "Task complete",
      title: "Pi Notification",
      voice_enabled: true,
      session_id: "session-1",
      source: "pi",
    });
  });
});
