# nucleo-matcher-napi

[![License](https://img.shields.io/github/license/idleberg/nucleo-matcher-napi?style=for-the-badge)](LICENSE)
[![Version](https://img.shields.io/npm/v/nucleo-matcher-napi?style=for-the-badge)](https://www.npmjs.org/package/nucleo-matcher-napi)
[![CI](https://img.shields.io/github/actions/workflow/status/idleberg/nucleo-matcher-napi/ci.yml?logo=nodedotjs&logoColor=white&style=for-the-badge)](https://github.com/idleberg/nucleo-matcher-napi/actions/workflows/ci.yml)

N-API bindings for [`nucleo-matcher`](https://crates.io/crates/nucleo-matcher), the fuzzy
matcher behind [Helix](https://helix-editor.com/). Built for Node and Electron.

> [!TIP]
> If you need to run in a browser, use [`nucleo-matcher-wasm`](https://www.npmjs.com/package/nucleo-matcher-wasm) instead.

## Installation

```sh
npm install nucleo-matcher-napi
```

Prebuilt binaries ship as `optionalDependencies`, one per triple. No compiler, no
`node-gyp`, no postinstall script.

|                  | glibc | musl |
| ---------------- | ----- | ---- |
| **linux-x64**    | ✅    | ✅   |
| **linux-arm64**  | ✅    | —    |
| **darwin-x64**   | ✅    |      |
| **darwin-arm64** | ✅    |      |
| **win32-x64**    | ✅    |      |
| **win32-arm64**  | ✅    |      |

Electron is covered by the same binaries — N-API is ABI-stable across Node and Electron, so
there is no separate `electron.napi.*` artifact.

## Usage

```ts
import { NucleoMatcher } from "nucleo-matcher-napi";

const paths = ["src/index.ts", "src/lib/parser.ts", "test/parser.test.ts"];
const matcher = new NucleoMatcher(paths, { matchPaths: true });

// Indices + scores as typed arrays. No strings cross the boundary.
const { indices, scores } = matcher.matchIndexed("parser", { maxResults: 50 });
indices; // Uint32Array [1, 2]
scores; // Uint32Array [159, 159]  <- tied; order is deterministic, see Design notes

// Off the JS thread, sharded across cores. Never blocks the event loop.
const hits = await matcher.matchIndexedAsync("parser", { maxResults: 50 });

// With highlight offsets, when you need to render them.
matcher.matchItems("parser");
// [{ item: "src/lib/parser.ts", score: 159, indices: [8, 9, 10, 11, 12, 13] }, ...]
```

### Query syntax

By default the query is parsed with nucleo's fzf-like syntax:

| syntax    | meaning                    |
| --------- | -------------------------- |
| `foo bar` | two atoms; both must match |
| `^src`    | must start with `src`      |
| `ts$`     | must end with `ts`         |
| `'exact`  | contiguous substring       |
| `!test`   | must _not_ match           |

Pass `{ literal: true }` to disable all of it and treat the query as one needle — spaces,
carets, and bangs included. Combine with `{ kind: "prefix" | "substring" | "exact" | "postfix" }`
for a non-fuzzy literal match.

> [!NOTE]
> Do not try to escape the metacharacters yourself. nucleo only treats `^ $ ' !` as special
> at atom boundaries, so `a\^b` matches a literal backslash, not a caret. Use `literal: true`.

### Async and threads

`matchIndexedAsync` runs on libuv's threadpool and shards the haystack across
`availableParallelism()` threads by default. Two caveats:

- libuv's pool is **4 threads** by default. Set `UV_THREADPOOL_SIZE` before requiring the
  module if you pass `threads` above 4.
- Below 4,096 items the parallel path is skipped; dispatch costs more than it saves.

Sync and async return byte-identical results for every thread count. That is asserted in
the test suite, not assumed.

## Benchmarks

Run `pnpm bench` to compare nucleo-matcher-napi against `zadeh` and `nucleo-matcher-wasm` on 95k Linux
kernel file paths. See [DEVELOPMENT.md](DEVELOPMENT.md) for methodology and caveats.

## Contributing

See [DEVELOPMENT.md](DEVELOPMENT.md) for setup, project structure, and design notes.

## License

This work is licensed under [Mozilla Public License 2.0](LICENSE).
