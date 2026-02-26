import { describe, it, expect, vi, beforeEach } from "vitest";
import { VoiceWaiter } from "./voice-waiter.js";

describe("VoiceWaiter", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it("resolves with text when resolve() called", async () => {
    const vw = new VoiceWaiter(5000);
    const p = vw.wait("msg1");
    expect(vw.pending).toBe(1);
    vw.resolve("msg1", "hello");
    expect(await p).toBe("hello");
    expect(vw.pending).toBe(0);
  });

  it("returns empty string on timeout", async () => {
    const vw = new VoiceWaiter(100);
    const p = vw.wait("msg2");
    vi.advanceTimersByTime(200);
    expect(await p).toBe("");
    expect(vw.pending).toBe(0);
  });

  it("returns false if no waiter to resolve", () => {
    const vw = new VoiceWaiter();
    expect(vw.resolve("nope", "text")).toBe(false);
  });

  it("cancel resolves with empty string", async () => {
    const vw = new VoiceWaiter(5000);
    const p = vw.wait("msg3");
    vw.cancel("msg3");
    expect(await p).toBe("");
    expect(vw.pending).toBe(0);
  });

  it("dispose cancels all waiters", async () => {
    const vw = new VoiceWaiter(5000);
    const p1 = vw.wait("a");
    const p2 = vw.wait("b");
    expect(vw.pending).toBe(2);
    vw.dispose();
    expect(await p1).toBe("");
    expect(await p2).toBe("");
    expect(vw.pending).toBe(0);
  });

  it("duplicate wait cancels previous", async () => {
    const vw = new VoiceWaiter(5000);
    const p1 = vw.wait("msg1");
    const p2 = vw.wait("msg1"); // replaces p1
    expect(vw.pending).toBe(1);
    expect(await p1).toBe(""); // cancelled
    vw.resolve("msg1", "second");
    expect(await p2).toBe("second");
  });
});
