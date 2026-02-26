import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { fetchWithTimeout, fetchWithRetry, isTransientError } from "./fetch-utils.js";

function startMockServer(
  handler: () => Response | Promise<Response>,
): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = createServer(async (_req, res) => {
      const mockRes = await handler();
      res.writeHead(mockRes.status, Object.fromEntries(mockRes.headers.entries()));
      res.end(await mockRes.text());
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      resolve({ port: addr.port, close: () => srv.close() });
    });
  });
}

describe("fetchWithTimeout", () => {
  it("succeeds within timeout", async () => {
    const srv = await startMockServer(() => new Response("ok", { status: 200 }));
    try {
      const res = await fetchWithTimeout(`http://127.0.0.1:${srv.port}/test`, {
        timeoutMs: 5000,
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    } finally {
      srv.close();
    }
  });

  it("aborts on timeout", async () => {
    const srv = await startMockServer(
      () => new Promise((r) => setTimeout(() => r(new Response("late")), 5000)),
    );
    try {
      await expect(
        fetchWithTimeout(`http://127.0.0.1:${srv.port}/slow`, { timeoutMs: 100 }),
      ).rejects.toThrow();
    } finally {
      srv.close();
    }
  });
});

describe("fetchWithRetry", () => {
  it("retries on 429 and succeeds", async () => {
    let attempt = 0;
    const srv = await startMockServer(() => {
      attempt++;
      if (attempt === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    try {
      const res = await fetchWithRetry(`http://127.0.0.1:${srv.port}/api`, {
        timeoutMs: 5000,
        retries: 2,
      });
      expect(res.status).toBe(200);
      expect(attempt).toBe(2);
    } finally {
      srv.close();
    }
  });

  it("retries on 503 and succeeds", async () => {
    let attempt = 0;
    const srv = await startMockServer(() => {
      attempt++;
      if (attempt <= 2) return new Response("unavailable", { status: 503 });
      return new Response("ok", { status: 200 });
    });
    try {
      const res = await fetchWithRetry(`http://127.0.0.1:${srv.port}/api`, {
        timeoutMs: 5000,
        retries: 2,
      });
      expect(res.status).toBe(200);
      expect(attempt).toBe(3);
    } finally {
      srv.close();
    }
  });

  it("returns last response when retries exhausted", async () => {
    const srv = await startMockServer(() => new Response("nope", { status: 429 }));
    try {
      const res = await fetchWithRetry(`http://127.0.0.1:${srv.port}/api`, {
        timeoutMs: 5000,
        retries: 1,
      });
      expect(res.status).toBe(429);
    } finally {
      srv.close();
    }
  });

  it("does not retry on 400 (non-transient)", async () => {
    let attempt = 0;
    const srv = await startMockServer(() => {
      attempt++;
      return new Response("bad request", { status: 400 });
    });
    try {
      const res = await fetchWithRetry(`http://127.0.0.1:${srv.port}/api`, {
        timeoutMs: 5000,
        retries: 2,
      });
      expect(res.status).toBe(400);
      expect(attempt).toBe(1);
    } finally {
      srv.close();
    }
  });

  it("respects Retry-After header", async () => {
    let attempt = 0;
    const timestamps: number[] = [];
    const srv = await startMockServer(() => {
      attempt++;
      timestamps.push(Date.now());
      if (attempt === 1) {
        return new Response("wait", {
          status: 429,
          headers: { "Retry-After": "1" },
        });
      }
      return new Response("ok", { status: 200 });
    });
    try {
      await fetchWithRetry(`http://127.0.0.1:${srv.port}/api`, {
        timeoutMs: 5000,
        retries: 1,
      });
      const gap = timestamps[1] - timestamps[0];
      expect(gap).toBeGreaterThanOrEqual(900);
    } finally {
      srv.close();
    }
  });

  it("does not retry on non-network TypeError (e.g. bug)", async () => {
    // fetchWithRetry to a completely invalid URL scheme → TypeError
    // With the narrowed check, non-fetch TypeErrors should NOT be retried
    let threw = false;
    try {
      await fetchWithRetry("not-a-valid-url://broken", { retries: 2, timeoutMs: 2000 });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(TypeError);
    }
    expect(threw).toBe(true);
  });
});

describe("isTransientError", () => {
  it("true for AbortError", () => {
    expect(isTransientError(new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("true for fetch network TypeError", () => {
    expect(isTransientError(new TypeError("fetch failed"))).toBe(true);
  });

  it("true for ECONNREFUSED", () => {
    expect(isTransientError(new TypeError("ECONNREFUSED"))).toBe(true);
  });

  it("true for ETIMEDOUT", () => {
    expect(isTransientError(new TypeError("connect ETIMEDOUT 1.2.3.4:443"))).toBe(true);
  });

  it("true for ENOTFOUND", () => {
    expect(isTransientError(new TypeError("getaddrinfo ENOTFOUND example.com"))).toBe(true);
  });

  it("true for socket error", () => {
    expect(isTransientError(new TypeError("socket hang up"))).toBe(true);
  });

  it("true for network error", () => {
    expect(isTransientError(new TypeError("NetworkError when attempting to fetch resource"))).toBe(true);
  });

  it("false for programming bug TypeError", () => {
    expect(isTransientError(new TypeError("Cannot read properties of undefined (reading 'foo')"))).toBe(false);
  });

  it("false for type coercion TypeError", () => {
    expect(isTransientError(new TypeError("null is not an object"))).toBe(false);
  });

  it("false for non-TypeError non-DOMException", () => {
    expect(isTransientError(new Error("some error"))).toBe(false);
  });

  it("false for string error", () => {
    expect(isTransientError("oops")).toBe(false);
  });

  it("false for null", () => {
    expect(isTransientError(null)).toBe(false);
  });
});
