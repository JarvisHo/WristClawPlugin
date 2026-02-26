import { describe, it, expect, vi, beforeEach } from "vitest";
import { MediaGroupBuffer, type MediaGroupEntry } from "./media-group.js";

describe("MediaGroupBuffer", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it("buffers a single image and flushes after delay", () => {
    const flushed: MediaGroupEntry<string>[] = [];
    const mgb = new MediaGroupBuffer<string>((e) => flushed.push(e), 500);

    const buffered = mgb.tryBuffer("ch:u1", "evt1", "ch1", "ws:ch1", "url1", true);
    expect(buffered).toBe(true);
    expect(mgb.pending).toBe(1);

    vi.advanceTimersByTime(600);
    expect(flushed).toHaveLength(1);
    expect(flushed[0].event).toBe("evt1");
    expect(flushed[0].extraMediaUrls).toEqual([]);
  });

  it("batches multiple images from same sender", () => {
    const flushed: MediaGroupEntry<string>[] = [];
    const mgb = new MediaGroupBuffer<string>((e) => flushed.push(e), 500);

    mgb.tryBuffer("ch:u1", "evt1", "ch1", "ws:ch1", "url1", true);
    vi.advanceTimersByTime(200);
    mgb.tryBuffer("ch:u1", "evt2", "ch1", "ws:ch1", "url2", true);
    vi.advanceTimersByTime(200);
    mgb.tryBuffer("ch:u1", "evt3", "ch1", "ws:ch1", "url3", true);

    // Not flushed yet
    expect(flushed).toHaveLength(0);
    expect(mgb.pending).toBe(1);

    vi.advanceTimersByTime(600);
    expect(flushed).toHaveLength(1);
    expect(flushed[0].event).toBe("evt1"); // first image is primary
    expect(flushed[0].extraMediaUrls).toEqual(["url2", "url3"]);
  });

  it("non-image flushes existing buffer immediately", () => {
    const flushed: MediaGroupEntry<string>[] = [];
    const mgb = new MediaGroupBuffer<string>((e) => flushed.push(e), 500);

    mgb.tryBuffer("ch:u1", "img1", "ch1", "ws:ch1", "url1", true);
    const buffered = mgb.tryBuffer("ch:u1", "text1", "ch1", "ws:ch1", undefined, false);

    expect(buffered).toBe(false); // not buffered (text msg)
    expect(flushed).toHaveLength(1); // image flushed
    expect(flushed[0].event).toBe("img1");
  });

  it("dispose flushes all pending", () => {
    const flushed: MediaGroupEntry<string>[] = [];
    const mgb = new MediaGroupBuffer<string>((e) => flushed.push(e), 500);

    mgb.tryBuffer("ch:u1", "e1", "ch1", "ws:ch1", "url1", true);
    mgb.tryBuffer("ch:u2", "e2", "ch2", "ws:ch2", "url2", true);
    expect(mgb.pending).toBe(2);

    mgb.dispose();
    expect(flushed).toHaveLength(2);
    expect(mgb.pending).toBe(0);
  });
});
