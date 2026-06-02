import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import atlasVoicePiAdapter from "../../../adapters/pi/index";

type Handler = (event: unknown, ctx: any) => Promise<void> | void;

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const originalDateNow = Date.now;

function createMockPi() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    api: {
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      registerCommand: () => {},
    },
  };
}

function createContext(sessionId = "session-1") {
  return {
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => sessionId,
    },
    signal: undefined,
    ui: { notify: () => {} },
  };
}

function assistantEvent(id: string, line = "Tests passed.") {
  return {
    message: {
      role: "assistant",
      id,
      content: `Summary\n🗣️ ${line}`,
    },
  };
}

beforeEach(() => {
  process.env = { ...originalEnv };
  for (const key of [
    "PI_SUBAGENT_CHILD",
    "PI_SUBAGENT_FANOUT_CHILD",
    "PI_SUBAGENT_PARENT_RUN_ID",
    "ATLAS_VOICE_SUPPRESS",
  ]) {
    delete process.env[key];
  }
  process.env.ATLAS_VOICE_NOTIFY_URL = "http://voice.example/notify";
  process.env.ATLAS_VOICE_CATCHPHRASE = "Pi session ready.";
  Date.now = originalDateNow;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  Date.now = originalDateNow;
});

describe("Pi adapter lifecycle", () => {
  test("session_start sends one configured greeting", async () => {
    const payloads: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };

    const { api, handlers } = createMockPi();
    atlasVoicePiAdapter(api as any);

    await handlers.get("session_start")?.({ reason: "startup" }, createContext());

    expect(payloads).toEqual([
      {
        message: "Pi session ready.",
        title: "Pi Notification",
        voice_enabled: true,
        session_id: "session-1",
        source: "pi",
      },
    ]);
  });

  test("message_end and turn_end for the same message speak once", async () => {
    const payloads: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };

    const { api, handlers } = createMockPi();
    atlasVoicePiAdapter(api as any);
    const event = assistantEvent("m1");
    const ctx = createContext();

    await handlers.get("message_end")?.(event, ctx);
    await handlers.get("turn_end")?.(event, ctx);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ message: "Tests passed.", source: "pi", session_id: "session-1" });
  });

  test("failed notify does not poison dedupe retry", async () => {
    const statuses = [503, 200];
    const payloads: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: statuses.shift() ?? 200 });
    };

    const { api, handlers } = createMockPi();
    atlasVoicePiAdapter(api as any);
    const event = assistantEvent("m1");
    const ctx = createContext();

    await handlers.get("message_end")?.(event, ctx);
    await handlers.get("turn_end")?.(event, ctx);

    expect(payloads).toHaveLength(2);
  });

  test("dedupe expires so repeated legitimate later turns can speak", async () => {
    let now = 1_000;
    Date.now = () => now;
    const payloads: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };

    const { api, handlers } = createMockPi();
    atlasVoicePiAdapter(api as any);
    const event = assistantEvent("m1");
    const ctx = createContext();

    await handlers.get("message_end")?.(event, ctx);
    await handlers.get("turn_end")?.(event, ctx);
    now += 5_001;
    await handlers.get("message_end")?.(event, ctx);

    expect(payloads).toHaveLength(2);
  });
});
