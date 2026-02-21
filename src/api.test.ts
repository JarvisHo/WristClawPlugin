import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { WristClawChannelConfig, WristClawUpdate } from "./types.ts";

// We need to mock fetch since api.ts uses global fetch
// Import after mocking
const baseConfig: WristClawChannelConfig = {
  baseUrl: "https://api.example.com",
  apiKey: "wc_test_key123",
};

describe("resolveApiKey", () => {
  it("returns apiKey when set", async () => {
    const { resolveApiKey } = await import("./api.ts");
    const key = resolveApiKey(baseConfig);
    assert.equal(key, "wc_test_key123");
  });

  it("throws when neither apiKey nor apiKeyFile set", async () => {
    const { resolveApiKey } = await import("./api.ts");
    assert.throws(
      () => resolveApiKey({ baseUrl: "http://localhost" } as WristClawChannelConfig),
      /no apiKey or apiKeyFile configured/,
    );
  });
});

describe("getMe", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns user on success", async () => {
    globalThis.fetch = mock.fn(async () =>
      new Response(JSON.stringify({
        ok: true,
        data: { id: "user-1", email: "test@test.com", displayName: "Test" },
      }), { status: 200 }),
    ) as typeof fetch;

    const { getMe } = await import("./api.ts");
    const result = await getMe(baseConfig);
    assert.equal(result.ok, true);
    assert.equal(result.user?.id, "user-1");
    assert.equal(result.user?.displayName, "Test");
  });

  it("returns error on HTTP failure", async () => {
    globalThis.fetch = mock.fn(async () =>
      new Response("Unauthorized", { status: 401 }),
    ) as typeof fetch;

    const { getMe } = await import("./api.ts");
    const result = await getMe(baseConfig);
    assert.equal(result.ok, false);
    assert.equal(result.error, "HTTP 401");
  });

  it("returns error on network failure", async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const { getMe } = await import("./api.ts");
    const result = await getMe(baseConfig);
    assert.equal(result.ok, false);
    assert.match(result.error!, /ECONNREFUSED/);
  });

  it("sends correct auth header", async () => {
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 });
    }) as typeof fetch;

    const { getMe } = await import("./api.ts");
    await getMe(baseConfig);
    assert.equal(capturedHeaders?.get("Authorization"), "Bearer wc_test_key123");
  });
});

describe("listPairs", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns pairs list", async () => {
    globalThis.fetch = mock.fn(async () =>
      new Response(JSON.stringify({
        ok: true,
        data: {
          pairs: [
            {
              id: "pair-1",
              created_at: "2026-01-01T00:00:00Z",
              partner: { id: "u2", email: "b@b.com", display_name: "Bob" },
            },
          ],
        },
      }), { status: 200 }),
    ) as typeof fetch;

    const { listPairs } = await import("./api.ts");
    const pairs = await listPairs(baseConfig);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].id, "pair-1");
    assert.equal(pairs[0].partner.display_name, "Bob");
  });

  it("throws on HTTP error", async () => {
    globalThis.fetch = mock.fn(async () =>
      new Response("Not Found", { status: 404 }),
    ) as typeof fetch;

    const { listPairs } = await import("./api.ts");
    await assert.rejects(() => listPairs(baseConfig), /HTTP 404/);
  });
});

describe("sendMessage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends text message and returns messageId", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    globalThis.fetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ ok: true, message_id: "12345" }), { status: 201 });
    }) as typeof fetch;

    const { sendMessage } = await import("./api.ts");
    const result = await sendMessage(baseConfig, "channel-abc", "Hello!");
    assert.equal(result.messageId, "12345");
    assert.equal(capturedUrl, "https://api.example.com/v1/api/pairs/channel-abc/messages");
    const body = JSON.parse(capturedBody);
    assert.equal(body.type, "text");
    assert.equal(body.text, "Hello!");
  });

  it("sends Content-Type header for POST", async () => {
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true, message_id: "1" }), { status: 201 });
    }) as typeof fetch;

    const { sendMessage } = await import("./api.ts");
    await sendMessage(baseConfig, "ch-1", "test");
    assert.equal(capturedHeaders?.get("Content-Type"), "application/json");
  });

  it("throws on HTTP error", async () => {
    globalThis.fetch = mock.fn(async () =>
      new Response("Bad Request", { status: 400 }),
    ) as typeof fetch;

    const { sendMessage } = await import("./api.ts");
    await assert.rejects(() => sendMessage(baseConfig, "ch-1", "test"), /HTTP 400/);
  });
});

describe("getUpdates", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches updates with correct URL params", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock.fn(async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ ok: true, updates: [] }), { status: 200 });
    }) as typeof fetch;

    const { getUpdates } = await import("./api.ts");
    await getUpdates(baseConfig, 42);
    assert.equal(capturedUrl, "https://api.example.com/v1/api/updates?offset=42&limit=100&timeout=30");
  });

  it("uses custom pollTimeoutSec", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock.fn(async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ ok: true, updates: [] }), { status: 200 });
    }) as typeof fetch;

    const { getUpdates } = await import("./api.ts");
    await getUpdates({ ...baseConfig, pollTimeoutSec: 10 }, 0);
    assert.match(capturedUrl, /timeout=10/);
  });

  it("returns updates array", async () => {
    const mockUpdates: WristClawUpdate[] = [
      {
        update_id: 1,
        event: "message:new",
        timestamp: "2026-01-01T00:00:00Z",
        data: { text: "hello", sender_id: "u1", sender_name: "Alice" },
      },
    ];
    globalThis.fetch = mock.fn(async () =>
      new Response(JSON.stringify({ ok: true, updates: mockUpdates }), { status: 200 }),
    ) as typeof fetch;

    const { getUpdates } = await import("./api.ts");
    const updates = await getUpdates(baseConfig, 0);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].event, "message:new");
    assert.equal(updates[0].data.text, "hello");
  });

  it("returns empty array when updates is null", async () => {
    globalThis.fetch = mock.fn(async () =>
      new Response(JSON.stringify({ ok: true, updates: null }), { status: 200 }),
    ) as typeof fetch;

    const { getUpdates } = await import("./api.ts");
    const updates = await getUpdates(baseConfig, 0);
    assert.equal(updates.length, 0);
  });

  it("does not send Content-Type for GET", async () => {
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true, updates: [] }), { status: 200 });
    }) as typeof fetch;

    const { getUpdates } = await import("./api.ts");
    await getUpdates(baseConfig, 0);
    assert.equal(capturedHeaders?.has("Content-Type"), false);
  });

  it("passes abort signal", async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify({ ok: true, updates: [] }), { status: 200 });
    }) as typeof fetch;

    const controller = new AbortController();
    const { getUpdates } = await import("./api.ts");
    await getUpdates(baseConfig, 0, controller.signal);
    assert.ok(capturedSignal);
    assert.equal(capturedSignal!.aborted, false);
  });
});
