// Orchestrator: spawns one child per (library, query), collects JSON, prints
// a Markdown table. Libraries that are not installed are skipped, so this
// works with `zadeh` and `nucleo-matcher-wasm` as optional devDependencies.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { arch, platform } from "node:os";
import { cpus } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { Table } from "console-table-printer";
import { QUERIES, MAX_RESULTS, corpus } from "./corpus.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const has = (m) => { try { require(m); return true; } catch { return false; } };
const hasPrebuilt = (m) => {
  try {
    const dir = join(dirname(require.resolve(m)), "prebuilds");
    return existsSync(join(dir, `${platform()}-${arch()}`)) || existsSync(join(dir, `${platform()}-x64`));
  } catch { return false; }
};

// Detect Apple Silicon reliably — sysctl hw.optional.arm64 returns 1 on any
// Apple Silicon Mac regardless of whether the current process is x64 or arm64.
const isAppleSilicon = platform() === "darwin" && (() => {
  try { return execFileSync("sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" }).trim() === "1"; }
  catch { return false; }
})();
const nodeArch = arch(); // what the current Node binary reports

const findFnmNode = (targetArch) => {
  const fileLabel = targetArch === "arm64" ? "arm64" : "x86_64";
  const fnmDir = join(process.env.FNM_DIR || join(process.env.HOME, ".fnm"), "node-versions");
  if (!existsSync(fnmDir)) return null;
  const semverSort = (a, b) => {
    const pa = a.slice(1).split(".").map(Number), pb = b.slice(1).split(".").map(Number);
    for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pb[i] - pa[i]; }
    return 0;
  };
  const versions = readdirSync(fnmDir).filter((d) => d.startsWith("v")).sort(semverSort);
  for (const v of versions) {
    const bin = join(fnmDir, v, "installation", "bin", "node");
    if (!existsSync(bin)) continue;
    try {
      const out = execFileSync("file", ["-b", bin], { encoding: "utf8" }).trim();
      if (out.includes(fileLabel)) return bin;
    } catch { /* skip */ }
  }
  return null;
};

// Determine which Node binary to use for each architecture requirement.
// nucleo-matcher-napi: local build matches hwArch (arm64 on Apple Silicon)
// zadeh: ships x64 prebuilds only
const arm64Node = nodeArch === "arm64" ? process.execPath : (isAppleSilicon ? findFnmNode("arm64") : null);
const x64Node = nodeArch === "x64" ? process.execPath : (isAppleSilicon ? findFnmNode("x64") : null);

// Map each lib to the Node binary it needs.
// nucleo-matcher-napi has a local .node for hwArch; zadeh ships x64 prebuilds only; wasm works anywhere.
const libNode = {
  "nucleo-matcher-napi": isAppleSilicon ? arm64Node : process.execPath,
  "zadeh": isAppleSilicon ? x64Node : process.execPath,
  "nucleo-matcher-wasm": process.execPath,
};

const canRun = (lib) => {
  if (lib === "nucleo-matcher-napi") return !!libNode[lib];
  if (lib === "zadeh") return !!libNode[lib] && (has("zadeh") || hasPrebuilt("zadeh"));
  if (lib === "nucleo-matcher-wasm") return has("nucleo-matcher-wasm");
  return false;
};

const LIBS = ["zadeh", "nucleo-matcher-napi", "nucleo-matcher-wasm"].filter(canRun);
const DISPLAY = { "nucleo-matcher-napi": "nucleo/napi", "nucleo-matcher-wasm": "nucleo/wasm", "zadeh": "zadeh" };

const run = (lib, query, mode = "sync") => {
  const exe = libNode[lib] || process.execPath;
  return JSON.parse(execFileSync(exe, [join(HERE, "runner.mjs"), lib, query, mode], { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim());
};

const items = corpus();
const archNote = isAppleSilicon && nodeArch !== "arm64" ? " (hw: arm64)" : "";
const rosettaNote = isAppleSilicon && x64Node && x64Node !== process.execPath ? " | zadeh via x64 (Rosetta)" : "";
const nativeNote = isAppleSilicon && arm64Node && arm64Node !== process.execPath ? " | nucleo via arm64" : "";
console.log(`\ncorpus: ${items.length} paths | maxResults=${MAX_RESULTS} | ${cpus().length} cpu | node ${process.version} | ${nodeArch}${archNote}${rosettaNote}${nativeNote}`);
console.log(`libraries: ${LIBS.join(", ")}\n`);
console.log("p50 ms, one process per measurement, 10 warmup + 25 reps\n");

const syncResults = {};
const asyncResults = {};

const msColumns = LIBS.map((lib) => ({ name: DISPLAY[lib], alignment: "right" }));
const mainTable = new Table({
  title: "sync (p50 ms)",
  columns: [{ name: "query", alignment: "left" }, ...msColumns],
});
for (const q of QUERIES) {
  syncResults[q] = {};
  const row = { query: q };
  for (const lib of LIBS) {
    const r = run(lib, q);
    syncResults[q][lib] = r;
    row[DISPLAY[lib]] = r.p50.toFixed(2);
  }
  mainTable.addRow(row);
}
mainTable.printTable();

for (const q of QUERIES) {
  asyncResults[q] = { "nucleo-matcher-napi": run("nucleo-matcher-napi", q, "async") };
}

if (LIBS.includes("zadeh")) {
  const speedupColumns = [
    { name: "query", alignment: "left" },
    { name: "zadeh", alignment: "right" },
    { name: "nucleo/napi", alignment: "right" },
    { name: "speedup", alignment: "right" },
  ];

  const syncSpeedup = new Table({ title: "nucleo/napi vs zadeh — sync", columns: speedupColumns });
  for (const q of QUERIES) {
    const z = syncResults[q]["zadeh"].p50, n = syncResults[q]["nucleo-matcher-napi"].p50;
    const ratio = z / n;
    syncSpeedup.addRow(
      { query: q, zadeh: z.toFixed(2), "nucleo/napi": n.toFixed(2), speedup: ratio.toFixed(2) + "x" },
      { color: ratio >= 1 ? "green" : "red" },
    );
  }
  syncSpeedup.printTable();

  const asyncSpeedup = new Table({ title: "nucleo/napi vs zadeh — async", columns: speedupColumns });
  for (const q of QUERIES) {
    const z = syncResults[q]["zadeh"].p50, n = asyncResults[q]["nucleo-matcher-napi"].p50;
    const ratio = z / n;
    asyncSpeedup.addRow(
      { query: q, zadeh: z.toFixed(2), "nucleo/napi": n.toFixed(2), speedup: ratio.toFixed(2) + "x" },
      { color: ratio >= 1 ? "green" : "red" },
    );
  }
  asyncSpeedup.printTable();
}

console.log(`
Notes
  - p90/p10 spread is reported per-measurement in runner.mjs; check it before
    trusting any ratio. On a shared or single-core box, expect >1.4x spread.
  - zadeh and nucleo rank differently by design. Speed is not the whole story;
    see tests/ranking.test.ts for a set-overlap check.
  - Threaded results depend on UV_THREADPOOL_SIZE (default 4) and on
    availableParallelism(). One vCPU means no parallelism, and async will look
    slightly *slower* than sync due to task dispatch overhead.
`);
