# Native Crates

Contributor-facing map of the Rust crates under `crates/`. These crates back
`@veyyon/natives` and the embedded shell/PTY runtime. They are intentionally
internal: end users see `@veyyon/natives` exports, not these crate APIs.

For the consumer-side runtime contract see
[`natives-architecture.md`](./natives-architecture.md). For inclusion policy
covering when a crate should be promoted to user-facing docs, see
[`user-facing-packages.md`](./user-facing-packages.md).

## Crate map

| Crate | Path | Role |
| --- | --- | --- |
| `veyyon-natives` | [`crates/veyyon-natives`](../../crates/veyyon-natives) | Top-level N-API `cdylib`; aggregates the other crates and exposes the JS-visible API. |
| `veyyon-shell` | [`crates/veyyon-shell`](../../crates/veyyon-shell) | Embedded shell / PTY / process management split out of `veyyon-natives` (wraps `brush-*`). |
| `veyyon-ast` | [`crates/veyyon-ast`](../../crates/veyyon-ast) | tree-sitter-based code summarizer and AST utilities; 50+ language grammars. |
| `veyyon-iso` | [`crates/veyyon-iso`](../../crates/veyyon-iso) | Task isolation backend resolver: APFS clones, btrfs/zfs reflinks, overlayfs, projfs, rcopy. |
| `veyyon-walker` | [`crates/veyyon-walker`](../../crates/veyyon-walker) | Parallel filesystem walker (ignore + globset) shared by grep, glob, and fs-scan cache. |
| `veyyon_uu_grep` | [`crates/veyyon-uu-grep`](../../crates/veyyon-uu-grep) | `grep` re-implemented on `grep-regex` / `grep-searcher`; runs in-process as a shell builtin. Entry: `veyyon_uu_grep::run`. |
| `veyyon-uu-diff` | [`crates/veyyon-uu-diff`](../../crates/veyyon-uu-diff) | `diff` as an in-process shell builtin on the `similar` library (unified output, `-q`, `-N`, recursive dirs). Entry: `veyyon_uu_diff::run`. |
| `veyyon-uutils-ctx` | [`crates/veyyon-uutils-ctx`](../../crates/veyyon-uutils-ctx) | Thread-local stdio + cwd context shim for embedding vendored uutils as in-process shell builtins. |
| `brush-core` | [`crates/vendor/brush-core`](../../crates/vendor/brush-core) | Vendored fork of [brush-shell](https://github.com/reubeno/brush) for embedded bash execution. |
| `brush-builtins` | [`crates/vendor/brush-builtins`](../../crates/vendor/brush-builtins) | Vendored bash builtins (`cd`, `echo`, `test`, `printf`, `read`, `export`, ...). |
| `uu-*` | [`crates/vendor/uu-*`](../../crates/vendor) | Vendored uutils coreutils (`cat`, `ls`, `sort`, `sed`, `find`, checksums, ...) embedded as in-process shell builtins via `veyyon-uutils-ctx`. |
| `jaq` | [`crates/vendor/jaq`](../../crates/vendor/jaq) | Vendored jq-compatible JSON processor embedded as the in-process `jq` builtin. |

## What lives where

- Native API surface and loader (`@veyyon/natives`):
  [`natives-architecture.md`](./natives-architecture.md),
  [`natives-addon-loader-runtime.md`](./natives-addon-loader-runtime.md),
  [`natives-binding-contract.md`](./natives-binding-contract.md),
  [`natives-build-release-debugging.md`](./natives-build-release-debugging.md),
  [`natives-media-system-utils.md`](./natives-media-system-utils.md),
  [`natives-rust-task-cancellation.md`](./natives-rust-task-cancellation.md),
  [`natives-shell-pty-process.md`](./natives-shell-pty-process.md),
  [`natives-text-search-pipeline.md`](./natives-text-search-pipeline.md).
- Porting cross-references:
  [`porting-from-pi-mono.md`](./porting-from-pi-mono.md),
  [`porting-to-natives.md`](./porting-to-natives.md).
- Filesystem scan cache contract that consumes `veyyon-walker`:
  [`fs-scan-cache-architecture.md`](./fs-scan-cache-architecture.md).

## Policy

These crates are implementation details. End-user docs live with the consuming
package (`@veyyon/natives`) and the architecture pages above. Promote a
crate to a dedicated user-facing doc only when it grows a standalone CLI or
public API consumed outside `packages/natives`.

*Verified against `d3e3db30` on 2026-07-23.*
