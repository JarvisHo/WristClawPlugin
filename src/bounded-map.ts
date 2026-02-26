/**
 * Bounded collections that evict old entries to prevent unbounded memory growth.
 */

/**
 * A Map that evicts the oldest entries when capacity is exceeded.
 * Uses insertion order (Map iteration order) for eviction.
 */
export class BoundedMap<K, V> {
  private map = new Map<K, V>();
  private cap: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new Error("capacity must be >= 1");
    this.cap = capacity;
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    // Delete first so re-insert moves to end (freshest)
    this.map.delete(key);
    this.map.set(key, value);
    this.evict();
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  private evict(): void {
    while (this.map.size > this.cap) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
      else break;
    }
  }

  /** Iterate entries (for cleanup logic). */
  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }
}

/**
 * A Set that evicts oldest entries when capacity is exceeded.
 * Returns false from `add()` if already present (for dedup).
 */
export class BoundedSet<V> {
  private set = new Set<V>();
  private cap: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new Error("capacity must be >= 1");
    this.cap = capacity;
  }

  /** Add value. Returns true if new, false if already present. */
  add(value: V): boolean {
    if (this.set.has(value)) return false;
    this.set.add(value);
    this.evict();
    return true;
  }

  has(value: V): boolean {
    return this.set.has(value);
  }

  delete(value: V): boolean {
    return this.set.delete(value);
  }

  clear(): void {
    this.set.clear();
  }

  get size(): number {
    return this.set.size;
  }

  private evict(): void {
    while (this.set.size > this.cap) {
      const first = this.set.values().next().value;
      if (first !== undefined) this.set.delete(first);
      else break;
    }
  }
}
