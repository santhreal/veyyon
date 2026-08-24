# The Bun surface: policy, conventions, and worker hosting

Bun is the runtime and the test runner today. The direction for this project's tooling is Rust and
Cargo: `crates/` is where capability keeps moving, and the TypeScript that stays should be ordinary
enough to port or retire cheaply. The rule in [`AGENTS.md`](../../AGENTS.md) follows from that; this
page holds the measurements, the history, and the local conventions.

## Why new code does not grow the surface

Bun appears in 5023 files: `bun:test` in 4564, `Bun.env` in 1289, `Bun.file` in 1259, `Bun.write` in
1232. That size is the argument for freezing the surface rather than migrating it.

- A drive-by rewrite of working code is churn and a merge conflict against whoever is editing that
  file.
- The test runner stays on `bun:test`. Moving off it is its own project with its own decision.
- Nothing here is a deprecation. Existing `Bun.file`, `Bun.write` and `Bun.env` calls are correct.

Two things the rule does not license:

- **Shelling out.** Spawning a process for something the standard library does in memory costs more
  and ports worse. `fs.mkdir(dir, { recursive: true })`, not a spawned `mkdir -p`; `$which("git")`
  from `@veyyon/utils`, not a spawned `which`. "Prefer a bash script" governs how a new tool under
  `scripts/` is written, not how application code touches the filesystem.
- **Adding a dependency.** `Bun.stringWidth()`, `Bun.wrapAnsi()`, `Bun.JSON5`, `Bun.JSONL` and
  `bun:sqlite` have no free portable equivalent. Replacing them with npm packages trades one Bun call
  for supply-chain surface, and a native build in the sqlite case.

## Node module imports

Namespace imports for `node:fs`, `node:path`, `node:os`:

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
```

An async-only file imports `node:fs/promises`. A file needing both sync and async imports `node:fs`
and reaches async through `fs.promises.xxx`. Keep sync APIs out of async flows; use one only when a
synchronous interface forces it.

## Paths that may be absent

Use `@veyyon/utils` — `readdirIfPresent`, `statIfPresent`, `pathExists` and its strict and quiet
twins — rather than `fs.existsSync` or `.catch(() => [])`. Pick by what should happen to a fault; the
header of `packages/utils/src/fs-optional.ts` documents the four contracts.

For a plain optional read, catch rather than probe first:

```typescript
import { isEnoent } from "@veyyon/utils";
try {
	return JSON.parse(await fs.readFile(configPath, "utf8"));
} catch (err) {
	if (isEnoent(err)) return null;
	throw err;
}
```

An existence check followed by a read is two syscalls and a race between them.

## Streams

Use the readers in `@veyyon/utils`: `readPipeText` for a whole pipe, then `readLines`, `readJsonl`,
`readSseEvents`. Write a manual reader loop only when the protocol needs one.

## Spawning

Existing call sites use Bun Shell (`` $`cmd` ``) with `.cwd(dir)`, `.quiet()`, `.nothrow()` and
`.text()`, and reach for `Bun.spawn` / `Bun.spawnSync` for long-running and streaming cases (LSP,
kernels, SSE, JSON-RPC). Leave them as they are. In pipe mode the stream needs a cast:

```typescript
const child = Bun.spawn(["cmd"], { stdout: "pipe", stderr: "pipe" });
const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
```

## Worker hosting

Workers re-enter the CLI entrypoint. `cli.ts` declares itself the worker host at startup
(`declareWorkerHostEntry()` from `@veyyon/utils/env`) and dispatches hidden argv selectors —
`__omp_worker_stats_sync`, `__omp_worker_tab`, `__omp_worker_js_eval`,
`__omp_worker_tiny_inference` — before loading the command registry.

```ts
import { workerHostEntry } from "@veyyon/utils";
const hostEntry = workerHostEntry();
const worker = hostEntry
	? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_<name>"] })
	: new Worker(new URL("./<worker>.ts", import.meta.url).href, { type: "module" });
```

When the process started from the veyyon CLI — source `cli.ts`, npm-bundle `dist/cli.js`, or a
compiled binary — `workerHostEntry()` returns `Bun.main` and the worker re-enters the single entry
module, so no per-worker `--compile` entrypoints or bundle entries exist. Outside a CLI host
(`bun test`, SDK embedding, standalone `veyyon-stats`) it returns `null` and the direct-module
fallback loads the worker source.

A new worker kind adds its selector to the dispatch table in `cli.ts` and keeps the fallback branch.

Two earlier shapes failed:

- `with { type: "file" }` copied the entry as a raw asset, so workers crashed silently in compiled
  binaries (issues #1011, #1027).
- The literal-path plus extra-entrypoint pattern required keeping spawn literals and two build
  scripts in sync (issue #1150).

`veyyon --smoke-test` spawns the stats sync worker and the tiny-model subprocess, pings them, and
exits. It is wired into `ci:test:smoke` and `scripts/install-tests/run-ci.sh`, so binary, source-link
and tarball installs all exercise it, and it is the live validation of this contract. A worker on a
different module graph gets a sibling smoke.

*Verified against `d26b915d1` on 2026-08-22.*
