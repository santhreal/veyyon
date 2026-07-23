# Filesystem Scan Cache Architecture Contract

This document defines the current contract for the shared filesystem scan cache implemented in Rust (`crates/veyyon-walker/src/cache.rs`) and consumed through the `veyyon_walker::WalkRequest` builder by native discovery/search APIs exposed to `packages/coding-agent`.

## What this cache is

The cache stores full directory-scan entry lists (`CollectedEntry` vectors) keyed by scan root plus the complete walk-option set. Higher-level operations (`glob` filtering, `fuzzyFind` scoring, and `astGrep`/`astEdit` file discovery) run against those cached entries.

Primary goals:

- avoid repeated filesystem walks for repeated discovery/search calls
- keep consistency across native discovery/search flows when they share the same scan policy
- allow explicit staleness recovery for empty results and explicit invalidation after file mutations

## Ownership and public surface

- Cache implementation and policy: `crates/veyyon-walker/src/cache.rs` (`collect_entries`, `invalidate_path`, `invalidate_path_string`, `invalidate_all`, env-configured policy getters)
- Walk entry point that consults the cache: `veyyon_walker::WalkRequest` (`crates/veyyon-walker/src/lib.rs`): the `.cache(bool)` builder flag routes `collect_entries` through `get_or_scan`
- Native consumers (`crates/veyyon-natives/src/`):
  - `glob.rs`: cache opt-in via config
  - `fd.rs` (`fuzzyFind`): cache opt-in via config
  - `ast.rs` (`astGrep`/`astEdit` file discovery): always cached (`.cache(true)`)
  - `grep.rs`: **not cached**: it builds its walk with `.cache(false)`; there is no cached grep directory mode today
- JS binding/export:
  - `packages/natives/native/index.d.ts` (`invalidateFsScanCache`)
  - `packages/natives/native/index.js`
- Coding-agent mutation invalidation helpers:
  - `packages/coding-agent/src/tools/fs-cache-invalidation.ts`

## Cache key partitioning (hard contract)

Each entry is keyed by `CacheKey { root, options }`:

- canonicalized `root` directory path
- the full `WalkOptions` struct with the `cache` flag zeroed out (`cache_key()` sets `options.cache = false` so cached and would-be-cached requests share entries)

`WalkOptions` dimensions that therefore partition the cache:

- `include_hidden`
- `use_gitignore`
- `skip_git`
- `skip_node_modules`
- `follow_links` (`FollowLinks::Never | Always | ...`): **is** part of the key
- `detail` (`WalkDetail::Minimal` or `WalkDetail::Full`)
- `order`, `emit_root`, `min_depth`, `max_depth`

Implications:

- Hidden and non-hidden scans do **not** share entries.
- Gitignore-respecting and ignore-disabled scans do **not** share entries.
- Scans that prune `node_modules` do **not** share entries with scans that include it.
- Minimal scans (path + file type only) do **not** share entries with full scans (mtime + regular-file size metadata).
- Calls that differ only by `follow_links` (or depth bounds, order, `emit_root`) get **separate** cache partitions.

Consumers must pass stable semantics for every walk option; changing any keyed flag creates a different cache partition.

## Scan collection behavior

Cache population uses the in-house parallel walker (`collect_entries_native` in `veyyon-walker`; the external `ignore::WalkBuilder` is no longer used for this path):

- entries sorted by path when `WalkOrder::Path` is requested (the common consumer setting)
- `.git` is pruned when `skip_git=true`: every native consumer sets `.skip_git(true)`; `should_skip_path` additionally drops `.git`/unmentioned `node_modules` components in user-facing discovery
- `node_modules` is pruned at traversal time when `skip_node_modules=true`
- cancellation heartbeat is checked every `HEARTBEAT_INTERVAL` (128) visited entries
- `WalkDetail::Minimal` records normalized relative path and file type only
- `WalkDetail::Full` also records mtime and regular-file size
- parallelism uses a centralized rayon pool: `VEYYON_WALK_WORKERS` (default 4; `0` = auto-detect, `1` = serial), engaged only at `PARALLEL_MIN_FILES` (256) or more items

Search roots for cache scans are resolved by `cache::resolve_search_path`:

- relative paths are resolved against current cwd
- target must be an existing directory
- root is canonicalized when possible

## Freshness and eviction policy

Global policy (environment-overridable):

- `FS_SCAN_CACHE_TTL_MS` (default `1000`)
- `FS_SCAN_EMPTY_RECHECK_MS` (default `200`)
- `FS_SCAN_CACHE_MAX_ENTRIES` (default `16`)

Behavior (`get_or_scan`, internal to `cache.rs`):

- if TTL is `0`: bypass cache entirely, always fresh scan (`cache_age_ms = 0`)
- on cache hit within TTL: return cloned cached entries + non-zero `cache_age_ms`
- on expired hit: evict key, rescan, store fresh entry
- on miss: scan fresh, store, return with `cache_age_ms = 0`
- max entry enforcement is oldest-first eviction by `created_at` after insert (`evict_oldest`)

There is no public `force_rescan` API anymore; an uncached request (`.cache(false)`) simply walks fresh without touching the shared cache.

## Empty-result fast recheck (separate from normal hits)

Normal cache hit:

- a cache hit inside TTL returns cached entries and does nothing else.

Empty-result fast recheck:

- this is now **walker-internal** policy, configured per request via `.empty_recheck(EmptyRecheck::Never | Configured | AfterMillis(n))`
- after filtering, if the surviving entry list is empty, the scan came from cache (`cache_age_ms > 0`), and the age is at or above the threshold (`empty_recheck_ms()` for `Configured`), the walker re-collects once with `options.cache = false`: a fresh, **uncached** scan that is not stored back
- intended to reduce stale-negative results when files were added while the cache is still inside TTL

Current consumers all pass `EmptyRecheck::Configured`: `glob`, `fuzzyFind` (`fd.rs`), and `astGrep`/`astEdit` (`ast.rs`).

## Consumer defaults and cache usage

Cache is opt-in on `glob`/`fuzzyFind` (`cache?: boolean`, default `false`). `astGrep`/`astEdit` file discovery always uses the cache (`.cache(true)`, no opt-in flag). `grep` never uses it (`.cache(false)`).

Current defaults in native APIs:

- `glob`: `hidden` per config, `gitignore=true`, `skip_git=true`, `node_modules` skipped unless the pattern mentions `node_modules`, `follow_links=Never`, `WalkOrder::Path`, full detail only when mtime/size metadata is needed (e.g. `sortByMtime=true` or a max-file-size filter)
- `fuzzyFind`: `hidden=false` by default, `gitignore=true`, `skip_git=true`, `node_modules` always skipped, `follow_links=Always`, minimal detail
- `astGrep`/`astEdit` (file discovery): `hidden=true`, `gitignore=true`, `skip_git=true`, always cached, `follow_links=Never`, minimal detail

Current callers:

- `@`-mention fuzzy file autocomplete enables cache (`fuzzyFind` with `cache: true`):
  - `packages/tui/src/autocomplete.ts`
- Mutation flows invalidate through `packages/coding-agent/src/tools/fs-cache-invalidation.ts`.

## Invalidation contract

Native invalidation entrypoint:

- `invalidateFsScanCache(path?: string)` → `cache::invalidate_path_string` / `cache::invalidate_all`
  - with `path`: remove cache entries whose root is a prefix of the target path (`target.starts_with(root)`)
  - without path: clear all scan cache entries

Path handling details:

- relative invalidation paths are resolved against cwd
- invalidation attempts canonicalization
- if target does not exist (for example after delete), fallback canonicalizes the parent and reattaches the filename when possible
- this preserves invalidation behavior for create/delete/rename where one side may not exist

## Coding-agent mutation flow responsibilities

Coding-agent code must invalidate after successful filesystem mutations.

Central helpers:

- `invalidateFsScanAfterWrite(path)`
- `invalidateFsScanAfterDelete(path)`
- `invalidateFsScanAfterRename(oldPath, newPath)` (invalidates both sides when paths differ)

Current mutation callsites include:

- `packages/coding-agent/src/tools/write.ts`
- `packages/coding-agent/src/tools/acp-bridge.ts`
- `packages/coding-agent/src/edit/hashline/filesystem.ts`
- `packages/coding-agent/src/edit/modes/patch.ts`
- `packages/coding-agent/src/edit/modes/replace.ts`

Rule: if a flow mutates filesystem content or location and bypasses these helpers, cache staleness bugs are expected.

## Adding a new cache consumer safely

When introducing cache use in a new scanner/search path:

1. **Use stable scan policy inputs**
   - decide hidden/gitignore/node_modules/follow-links/detail/depth semantics first
   - pass them consistently on every `WalkRequest` so cache partitions are intentional

2. **Treat cache data as pre-filtered only by traversal policy**
   - apply tool-specific filtering (glob patterns, type filters, scoring) after retrieval: `WalkFilter` runs on top of the cached entry list
   - never assume cached entries already reflect your higher-level filters

3. **Enable empty-result fast recheck only for stale-negative risk**
   - set `.empty_recheck(EmptyRecheck::Configured)` (or `AfterMillis(n)` for a custom threshold)
   - the walker handles the retry internally; do not hand-roll a second scan

4. **Respect no-cache mode explicitly**
   - when the caller disables cache, pass `.cache(false)`: the walk runs fresh and never populates the shared cache

5. **Wire mutation invalidation for any new write path**
   - after successful write/edit/delete/rename, call the coding-agent invalidation helper
   - for rename/move, invalidate both old and new paths

6. **Do not add per-call TTL knobs**
   - current contract is global policy only (env-configured), no per-request TTL override

## Known boundaries

- Cache scope is process-local in-memory (`DashMap`), not persisted across process restarts.
- Cache stores scan entries, not final tool results.
- `glob`/`fuzzyFind`/`astGrep` share scan entries only when the full `WalkOptions` key matches.
- Every native consumer sets `skip_git=true`, so `.git` is excluded from all cached scans in practice; `should_skip_path` re-enforces it at the discovery-filter layer.

*Verified against `d3e3db30` on 2026-07-23.*
