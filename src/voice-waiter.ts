/**
 * Voice transcription waiter: resolves when message:update arrives with text,
 * or times out after VOICE_WAIT_MS.
 */

const DEFAULT_VOICE_WAIT_MS = 15_000;

type Waiter = {
  resolve: (text: string) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class VoiceWaiter {
  private waiters = new Map<string, Waiter>();
  private waitMs: number;

  constructor(waitMs = DEFAULT_VOICE_WAIT_MS) {
    this.waitMs = waitMs;
  }

  /** Wait for transcription text. Returns text or empty string on timeout. */
  wait(messageId: string): Promise<string> {
    // If already waiting, cancel old one
    this.cancel(messageId);

    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(messageId);
        resolve("");
      }, this.waitMs);
      this.waiters.set(messageId, { resolve, timer });
    });
  }

  /** Resolve a pending waiter with transcription text. Returns true if resolved. */
  resolve(messageId: string, text: string): boolean {
    const waiter = this.waiters.get(messageId);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.waiters.delete(messageId);
    waiter.resolve(text);
    return true;
  }

  /** Cancel a specific waiter. */
  cancel(messageId: string): void {
    const waiter = this.waiters.get(messageId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(messageId);
      waiter.resolve("");
    }
  }

  /** Cancel all pending waiters (for shutdown). */
  dispose(): void {
    for (const [, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve("");
    }
    this.waiters.clear();
  }

  /** Number of pending waiters (for testing). */
  get pending(): number {
    return this.waiters.size;
  }
}
