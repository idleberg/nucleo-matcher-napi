// Runs ONE library in ONE process. Never benchmark two engines in one process:
// doing so produced a 3x phantom slowdown on a zero-hit query, purely from GC
// and memory pressure between the WASM heap and the native allocator.
import { createRequire } from "node:module";
import { corpus, MAX_RESULTS } from "./corpus.mjs";

const require = createRequire(import.meta.url);
const [lib, query, mode = "sync"] = process.argv.slice(2);
const items = corpus();
const now = () => Number(process.hrtime.bigint()) / 1e6;

let fn;
switch (lib) {
  case "nucleo-matcher-napi": {
    const { NucleoMatcher } = require("../index.js");
    const m = new NucleoMatcher(items, { matchPaths: true });
    fn = mode === "async"
      ? () => m.matchIndexedAsync(query, { maxResults: MAX_RESULTS, literal: true })
      : () => m.matchIndexed(query, { maxResults: MAX_RESULTS, literal: true });
    break;
  }
  case "zadeh": {
    const { StringArrayFilterer } = require("zadeh");
    const z = new StringArrayFilterer();
    z.setCandidates(items);
    fn = () => z.filterIndices(query, { maxResults: MAX_RESULTS });
    break;
  }
  case "nucleo-matcher-wasm": {
    const { NucleoMatcher } = await import("nucleo-matcher-wasm");
    const w = new NucleoMatcher(items, { matchPaths: true });
    fn = () => w.matchLiteralIndexed(query, "fuzzy", { maxResults: MAX_RESULTS });
    break;
  }
  default:
    throw new Error(`unknown library: ${lib}`);
}

const WARMUP = 10;
const REPS = 25;
for (let i = 0; i < WARMUP; i++) await fn();
const t = [];
for (let i = 0; i < REPS; i++) {
  const a = now();
  await fn();
  t.push(now() - a);
}
t.sort((a, b) => a - b);
const q = (p) => t[Math.min(REPS - 1, Math.floor(REPS * p))];
process.stdout.write(JSON.stringify({ lib, query, mode, p10: q(0.1), p50: q(0.5), p90: q(0.9) }) + "\n");
