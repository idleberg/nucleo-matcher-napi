import { describe, expect, it } from "vitest";
import { NucleoMatcher } from "../index.js";

const PATHS = [
  "foo/bar",
  "bar/foo",
  "foobar",
  "src/index.ts",
  "src/lib/parser.ts",
  "test/parser.test.ts",
];

describe("reference values", () => {
  // Straight from nucleo-matcher's docs.rs example. If these drift, the
  // underlying crate changed scoring and every snapshot downstream is stale.
  it("matches the upstream doc example exactly", () => {
    const m = new NucleoMatcher(["foo/bar", "bar/foo", "foobar"], { matchPaths: true });
    const { indices, scores } = m.matchIndexed("foo bar");
    expect([...indices]).toEqual([0, 1, 2]);
    expect([...scores]).toEqual([168, 168, 140]);
  });
});

describe("ordering", () => {
  it("breaks score ties by ascending haystack index", () => {
    const items = ["a/x", "b/x", "c/x", "d/x"];
    const m = new NucleoMatcher(items);
    const { indices, scores } = m.matchIndexed("x");
    expect(new Set(scores).size).toBe(1); // all tied
    expect([...indices]).toEqual([0, 1, 2, 3]);
  });

  it("is stable across repeated calls", () => {
    const items = Array.from({ length: 500 }, (_, i) => `pkg${i}/mod.rs`);
    const m = new NucleoMatcher(items);
    const a = [...m.matchIndexed("mod").indices];
    const b = [...m.matchIndexed("mod").indices];
    expect(a).toEqual(b);
  });

  it("sorts by descending score", () => {
    const m = new NucleoMatcher(PATHS, { matchPaths: true });
    const { scores } = m.matchIndexed("parser");
    const arr = [...scores];
    expect(arr).toEqual([...arr].sort((x, y) => y - x));
  });
});

describe("maxResults", () => {
  const m = new NucleoMatcher(PATHS, { matchPaths: true });

  it("returns the top k, in the same order as an uncapped call", () => {
    const all = [...m.matchIndexed("s").indices];
    const capped = [...m.matchIndexed("s", { maxResults: 2 }).indices];
    expect(capped).toEqual(all.slice(0, 2));
  });

  it("handles k larger than the hit count", () => {
    const all = [...m.matchIndexed("parser").indices];
    const capped = [...m.matchIndexed("parser", { maxResults: 9999 }).indices];
    expect(capped).toEqual(all);
  });

  it("handles k = 0", () => {
    expect([...m.matchIndexed("parser", { maxResults: 0 }).indices]).toEqual([]);
  });
});

describe("query syntax", () => {
  const m = new NucleoMatcher(PATHS, { matchPaths: true });

  it("parses fzf atoms by default", () => {
    expect([...m.matchIndexed("^src").indices].map((i) => PATHS[i])).toEqual([
      "src/index.ts",
      "src/lib/parser.ts",
    ]);
    expect([...m.matchIndexed("ts$").indices].every((i) => PATHS[i].endsWith("ts"))).toBe(true);
  });

  it("splits on whitespace into atoms", () => {
    const r = [...m.matchIndexed("src parser").indices].map((i) => PATHS[i]);
    expect(r).toEqual(["src/lib/parser.ts"]);
  });

  it("supports negation", () => {
    const r = [...m.matchIndexed("parser !test").indices].map((i) => PATHS[i]);
    expect(r).toEqual(["src/lib/parser.ts"]);
  });

  it("treats metacharacters literally with { literal: true }", () => {
    const items = ["a^b", "a b", "c!d", "e$f"];
    const lit = new NucleoMatcher(items);
    for (const q of ["a^b", "a b", "c!d", "e$f"]) {
      expect([...lit.matchIndexed(q, { literal: true }).indices].map((i) => items[i])).toEqual([q]);
    }
  });

  it("supports literal kinds", () => {
    const m2 = new NucleoMatcher(["foobar", "foo/bar", "barfoo"]);
    const pick = (o: object) => [...m2.matchIndexed("foo", o).indices];
    expect(pick({ literal: true, kind: "prefix" })).toEqual([0, 1]);
    expect(pick({ literal: true, kind: "exact" })).toEqual([]);
    expect(pick({ literal: true, kind: "postfix" })).toEqual([2]);
  });

  it("matches everything on an empty query", () => {
    expect([...m.matchIndexed("").indices].length).toBe(PATHS.length);
  });
});

describe("sync / async parity", () => {
  const items = Array.from({ length: 20_000 }, (_, i) => `drivers/net/eth${i}/main.c`);

  it("agrees for every thread count", async () => {
    const m = new NucleoMatcher(items, { matchPaths: true });
    const sync = m.matchIndexed("net main", { maxResults: 50 });
    for (const threads of [1, 2, 4, 8]) {
      const async = await m.matchIndexedAsync("net main", { maxResults: 50, threads });
      expect([...async.indices]).toEqual([...sync.indices]);
      expect([...async.scores]).toEqual([...sync.scores]);
    }
  });

  it("agrees when the haystack is smaller than the parallel threshold", async () => {
    const m = new NucleoMatcher(PATHS);
    const sync = m.matchIndexed("parser");
    const async = await m.matchIndexedAsync("parser", { threads: 8 });
    expect([...async.indices]).toEqual([...sync.indices]);
  });
});

describe("matchItems", () => {
  const m = new NucleoMatcher(PATHS, { matchPaths: true });

  it("returns sorted, deduplicated highlight offsets", () => {
    for (const r of m.matchItems("parser")) {
      expect(r.indices).toEqual([...new Set(r.indices)].sort((a, b) => a - b));
      expect(Math.max(...r.indices)).toBeLessThan(r.item.length);
    }
  });

  it("agrees with matchIndexed on items and scores", () => {
    const idx = m.matchIndexed("parser");
    const items = m.matchItems("parser");
    expect(items.map((r) => r.item)).toEqual([...idx.indices].map((i) => PATHS[i]));
    expect(items.map((r) => r.score)).toEqual([...idx.scores]);
  });
});

describe("misc", () => {
  it("exposes size and itemAt", () => {
    const m = new NucleoMatcher(PATHS);
    expect(m.size).toBe(PATHS.length);
    expect(m.itemAt(1)).toBe("bar/foo");
    expect(m.itemAt(999)).toBeNull();
  });

  it("setItems replaces the haystack", () => {
    const m = new NucleoMatcher(["aaa"]);
    m.setItems(["bbb", "bbc"]);
    expect(m.size).toBe(2);
    expect([...m.matchIndexed("bb").indices]).toEqual([0, 1]);
  });

  it("scores a single pair", () => {
    // match_paths() changes the word-boundary bonus, so the same pair scores
    // differently under the two configs. Both values pinned deliberately.
    expect(new NucleoMatcher([]).score("foo", "foobar")).toBe(88);
    expect(new NucleoMatcher([], { matchPaths: true }).score("foo", "foobar")).toBe(84);
    expect(new NucleoMatcher([]).score("zzz", "foobar")).toBeNull();
  });

  it("rejects invalid options", () => {
    expect(() => new NucleoMatcher([], { caseMatching: "bogus" })).toThrow(/caseMatching/);
    expect(() => new NucleoMatcher([], { normalization: "bogus" })).toThrow(/normalization/);
    const m = new NucleoMatcher([]);
    expect(() => m.matchIndexed("a", { literal: true, kind: "bogus" })).toThrow(/kind/);
  });

  it("honours caseMatching", () => {
    const items = ["Foo", "foo"];
    expect([...new NucleoMatcher(items, { caseMatching: "respect" }).matchIndexed("foo").indices]).toEqual([1]);
    expect([...new NucleoMatcher(items, { caseMatching: "ignore" }).matchIndexed("foo").indices].length).toBe(2);
  });
});
