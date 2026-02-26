/**
 * Media group buffer: batches rapid sequential image messages from the same
 * sender in a channel, then flushes as a single multi-image dispatch.
 */

const DEFAULT_DELAY_MS = 800;

export type MediaGroupEntry<T> = {
  /** Primary event (first image) */
  event: T;
  channelId: string;
  wsChannel: string;
  /** Additional image URLs from subsequent messages */
  extraMediaUrls: string[];
  timer: ReturnType<typeof setTimeout>;
};

export type MediaGroupFlushFn<T> = (entry: MediaGroupEntry<T>) => void;

export class MediaGroupBuffer<T> {
  private buffer = new Map<string, MediaGroupEntry<T>>();
  private delayMs: number;
  private onFlush: MediaGroupFlushFn<T>;

  constructor(onFlush: MediaGroupFlushFn<T>, delayMs = DEFAULT_DELAY_MS) {
    this.onFlush = onFlush;
    this.delayMs = delayMs;
  }

  /**
   * Buffer an image message. Returns true if buffered.
   * If a non-image arrives from the same sender, flushes existing buffer and returns false.
   */
  tryBuffer(
    key: string,
    event: T,
    channelId: string,
    wsChannel: string,
    mediaUrl: string | undefined,
    isImage: boolean,
  ): boolean {
    if (!isImage) {
      // Non-image from same sender: flush any buffered group
      const existing = this.buffer.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        this.flush(key);
      }
      return false;
    }

    const existing = this.buffer.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      if (mediaUrl) existing.extraMediaUrls.push(mediaUrl);
      existing.timer = setTimeout(() => this.flush(key), this.delayMs);
    } else {
      const timer = setTimeout(() => this.flush(key), this.delayMs);
      this.buffer.set(key, {
        event,
        channelId,
        wsChannel,
        extraMediaUrls: [],
        timer,
      });
    }
    return true;
  }

  /** Flush a specific entry. */
  flush(key: string): void {
    const entry = this.buffer.get(key);
    if (!entry) return;
    this.buffer.delete(key);
    this.onFlush(entry);
  }

  /** Flush all pending entries (for shutdown). */
  dispose(): void {
    for (const [key, entry] of this.buffer) {
      clearTimeout(entry.timer);
      this.buffer.delete(key);
      this.onFlush(entry);
    }
  }

  /** Number of pending groups (for testing). */
  get pending(): number {
    return this.buffer.size;
  }
}
