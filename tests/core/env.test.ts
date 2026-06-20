import { describe, expect, test } from "bun:test";
import { parseBoundedInt } from "../../core/env";

// parseBoundedInt is the single guard behind every numeric env override in the
// voice system (issue #25). A degenerate value (NaN / negative / below floor)
// must fall back to the documented DEFAULT, never to a value that masks a real
// outage (0ms timeout, 0 retries, threshold that opens on the first failure).
describe("parseBoundedInt — degenerate env values fall back to default", () => {
  test("valid in-range values are parsed", () => {
    expect(parseBoundedInt("30000", 15000, 1)).toBe(30000);
    expect(parseBoundedInt("3", 1, 0)).toBe(3);
  });

  test("non-numeric / undefined / empty fall back", () => {
    expect(parseBoundedInt("abc", 15000, 1)).toBe(15000);
    expect(parseBoundedInt(undefined, 15000, 1)).toBe(15000);
    expect(parseBoundedInt("", 15000, 1)).toBe(15000);
    expect(parseBoundedInt("   ", 15000, 1)).toBe(15000);
  });

  test("values below the floor fall back (negative always rejected)", () => {
    expect(parseBoundedInt("-5", 15000, 1)).toBe(15000);
    expect(parseBoundedInt("-1", 2, 1)).toBe(2);
  });

  describe("call-site floors", () => {
    // timeout floor 1: 0ms would make setTimeout fire instantly → every synth
    // "times out" → false outage.
    test("EDGETTS_TIMEOUT_MS floor rejects 0", () => {
      expect(parseBoundedInt("0", 15000, 1)).toBe(15000);
      expect(parseBoundedInt("1", 15000, 1)).toBe(1);
    });

    // retries floor 0: 0 retries is a LEGITIMATE config (single attempt), so it
    // must be honored — only NaN/negative fall back.
    test("EDGETTS_SYNTH_RETRIES floor allows 0 but rejects NaN/negative", () => {
      expect(parseBoundedInt("0", 1, 0)).toBe(0);
      expect(parseBoundedInt("abc", 1, 0)).toBe(1);
      expect(parseBoundedInt("-2", 1, 0)).toBe(1);
    });

    // backoff floor 1.
    test("EDGETTS_SYNTH_BACKOFF_MS floor rejects 0", () => {
      expect(parseBoundedInt("0", 250, 1)).toBe(250);
      expect(parseBoundedInt("500", 250, 1)).toBe(500);
    });

    // threshold floor 1: 0/negative would open the breaker on (or before) the
    // first failure → masks nothing but defeats the tuning; falls back to 2.
    test("CIRCUIT_BREAKER_THRESHOLD floor rejects 0 and negative", () => {
      expect(parseBoundedInt("0", 2, 1)).toBe(2);
      expect(parseBoundedInt("-1", 2, 1)).toBe(2);
      expect(parseBoundedInt("3", 2, 1)).toBe(3);
    });
  });
});
