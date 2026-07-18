# @veyyon/utils

Shared utilities for [veyyon](https://github.com/santhreal/veyyon) packages. Bun-first.

## Notable modules

| Module | Purpose |
| --- | --- |
| `logger` | Centralized logger writing to `~/.veyyon/logs/` with rotation (TUI-safe — never stdout) |
| `prompt` | Handlebars-based prompt templating and formatting helpers |
| `dirs` | Path helpers for veyyon config directories (`~/.veyyon`, XDG-aware on Linux) |
| `stream` | `readStream` / `readLines` helpers over `ReadableStream` |
| `ptree` / `procmgr` | Process trees, `ChildProcess` wrapper, process lifecycle management |
| `postmortem` | Cleanup callbacks on exit, signals, and fatal exceptions |
| `which` | `$which()` binary lookup with caching |
| `fetch-retry` | `fetch` with retry/backoff policies |
| `fs-error` | Errno guards (`isEnoent` and friends) |
| `env` / `worker-host` | Environment plumbing and side-effect-free worker-host entry contract (`workerHostEntry`) |
| `abortable` / `async` | AbortSignal-aware stream/promise helpers |
| `peek-file` | Read the first N bytes of a file with pooled buffers |
| `frontmatter`, `glob`, `mime`, `temp`, `format`, `color`, `snowflake`, `tab-spacing`, `path-tree`, `sanitize-text` | Smaller single-purpose helpers |

Import from the root barrel or per-module subpaths (`@veyyon/utils/<module>`).

## Install

```sh
bun add @veyyon/utils
```

Ships TypeScript source directly (no build step); requires Bun ≥ 1.3.14.

## References

- [Monorepo README](https://github.com/santhreal/veyyon#readme)
- [CHANGELOG](./CHANGELOG.md)
