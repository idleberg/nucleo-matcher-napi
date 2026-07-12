/**
 * nucleo and zadeh return nearly the same *set* of matches and rank them
 * differently. This suite pins that relationship so a migration is informed
 * rather than surprising. It is not a correctness test of either library.
 *
 * Skipped when zadeh is not installed.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { NucleoMatcher } from "../index.js";

const require = createRequire(import.meta.url);
let zadeh: any = null;
try {
  zadeh = require("zadeh");
} catch {
  /* optional devDependency */
}

const PATHS = [
  "include/linux/netfilter/nfnetlink.h",
  "include/uapi/linux/netfilter/nfnetlink.h",
  "net/netfilter/nfnetlink.c",
  "fs/nfsd/netlink.c",
  "drivers/infiniband/core/netlink.c",
  "drivers/net/ethernet/fungible/funeth/funeth_devlink.c",
  "kernel/sched/core.c",
  "mm/mmap.c",
];

const d = zadeh ? describe : describe.skip;

d("ranking vs zadeh", () => {
  let nucleo: NucleoMatcher;
  let z: any;
  let nucleoRank: (q: string) => string[];
  let zadehRank: (q: string) => string[];

  beforeAll(() => {
    nucleo = new NucleoMatcher(PATHS, { matchPaths: true });
    z = new zadeh.StringArrayFilterer();
    z.setCandidates(PATHS);
    nucleoRank = (q: string) =>
      [...nucleo.matchIndexed(q, { literal: true }).indices].map((i) => PATHS[i]);
    zadehRank = (q: string) => z.filterIndices(q).map((i: number) => PATHS[i]);
  });

  it("agrees on the match set", () => {
    for (const q of ["nfnetlink", "netlink", "sched"]) {
      expect(new Set(nucleoRank(q))).toEqual(new Set(zadehRank(q)));
    }
  });

  it("does NOT preserve result order across the migration", () => {
    // If this ever starts failing, one of the two libraries changed its
    // scoring. Investigate before deleting.
    const n = nucleoRank("nfnetlink");
    const z2 = zadehRank("nfnetlink");
    expect(new Set(n)).toEqual(new Set(z2));
    expect(n).not.toEqual(z2);
  });
});

/**
 * The interesting divergence only appears with real competition. On eight
 * candidates zadeh happily ranks `nfnetlink` first; on 94,841 kernel paths its
 * top three contain no file named `nfnetlink` at all, because a scattered
 * subsequence (f-s / n-f-s-d / n-e-t-l-i-n-k) collects enough path and acronym
 * bonuses to outscore the literal match.
 *
 * Requires the benchmark corpus, which `pnpm bench` caches.
 */
const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "benchmark", ".corpus.txt");
const dCorpus = zadeh && existsSync(CORPUS) ? describe : describe.skip;

dCorpus("ranking vs zadeh, full kernel corpus", () => {
  let items: string[];
  let nucleo: NucleoMatcher;
  let z: any;

  beforeAll(() => {
    items = readFileSync(CORPUS, "utf8").split("\n").filter(Boolean);
    nucleo = new NucleoMatcher(items, { matchPaths: true });
    z = new zadeh.StringArrayFilterer();
    z.setCandidates(items);
  });

  it("nucleo ranks literal substring matches first; zadeh does not", () => {
    const n = [...nucleo.matchIndexed("nfnetlink", { literal: true, maxResults: 3 }).indices].map(
      (i) => items[i]
    );
    const z2 = z.filterIndices("nfnetlink", { maxResults: 3 }).map((i: number) => items[i]);

    expect(n.every((p: string) => p.includes("nfnetlink"))).toBe(true);
    expect(z2.some((p: string) => p.includes("nfnetlink"))).toBe(false);
  });

  it("returns exactly the same match set", () => {
    const n = [...nucleo.matchIndexed("nfnetlink", { literal: true }).indices];
    const z2 = z.filterIndices("nfnetlink");
    expect(n.length).toBe(z2.length);
    expect(new Set(n)).toEqual(new Set(z2));
  });

  it("the top-50 rankings largely agree", () => {
    // NB: zadeh's own `{ maxResults: 50 }` returns a different set than the
    // first 50 of its uncapped ranking — its top-k selection disagrees with its
    // full sort. We slice the uncapped list so we compare like for like.
    const n = new Set([...nucleo.matchIndexed("nfnetlink", { literal: true, maxResults: 50 }).indices]);
    const z2 = z.filterIndices("nfnetlink").slice(0, 50);
    const overlap = z2.filter((i: number) => n.has(i)).length;
    expect(overlap).toBeGreaterThanOrEqual(45);
  });
});
