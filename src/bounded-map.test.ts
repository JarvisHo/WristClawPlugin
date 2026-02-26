import { describe, it, expect } from "vitest";
import { BoundedMap, BoundedSet } from "./bounded-map.js";

describe("BoundedMap", () => {
  it("evicts oldest when over capacity", () => {
    const m = new BoundedMap<string, number>(3);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    m.set("d", 4); // evicts "a"
    expect(m.size).toBe(3);
    expect(m.has("a")).toBe(false);
    expect(m.get("d")).toBe(4);
  });

  it("re-set refreshes position", () => {
    const m = new BoundedMap<string, number>(3);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    m.set("a", 10); // refresh "a" to newest
    m.set("d", 4); // evicts "b" (oldest now)
    expect(m.has("a")).toBe(true);
    expect(m.has("b")).toBe(false);
  });

  it("clear empties the map", () => {
    const m = new BoundedMap<string, number>(5);
    m.set("x", 1);
    m.clear();
    expect(m.size).toBe(0);
  });

  it("throws on invalid capacity", () => {
    expect(() => new BoundedMap(0)).toThrow();
  });
});

describe("BoundedSet", () => {
  it("add returns true for new, false for existing", () => {
    const s = new BoundedSet<string>(5);
    expect(s.add("a")).toBe(true);
    expect(s.add("a")).toBe(false);
  });

  it("evicts oldest when over capacity", () => {
    const s = new BoundedSet<string>(2);
    s.add("a");
    s.add("b");
    s.add("c"); // evicts "a"
    expect(s.size).toBe(2);
    expect(s.has("a")).toBe(false);
    expect(s.has("c")).toBe(true);
  });

  it("add returns false without evicting for dupes", () => {
    const s = new BoundedSet<string>(2);
    s.add("a");
    s.add("b");
    expect(s.add("a")).toBe(false); // no eviction
    expect(s.size).toBe(2);
    expect(s.has("b")).toBe(true);
  });
});
