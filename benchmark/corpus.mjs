// Real-world corpus: 94,841 Linux kernel file paths, avg 39 chars.
// Pinned to a commit so numbers are comparable across runs and machines.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHA = "0e35b9b6ec0ffcc5e23cbdec09f5c622ad532b53";
const CACHE = join(HERE, ".corpus.txt");
const REPO = join(HERE, ".linux.git");

export function corpus() {
  if (existsSync(CACHE)) return readFileSync(CACHE, "utf8").split("\n").filter(Boolean);

  if (!existsSync(REPO)) {
    // blobless clone: trees only, ~1% of a full clone
    execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout", "https://github.com/torvalds/linux", REPO], { stdio: "inherit" });
  }
  execFileSync("git", ["-C", REPO, "fetch", "--depth", "1", "origin", SHA], { stdio: "inherit" });
  const out = execFileSync("git", ["-C", REPO, "ls-tree", "-r", "--name-only", SHA], { maxBuffer: 1 << 28 }).toString();
  writeFileSync(CACHE, out);
  return out.split("\n").filter(Boolean);
}

export const QUERIES = ["zzqx", "sched", "mmap", "netfilter", "nfnetlink", "drivers"];
export const MAX_RESULTS = 200;
