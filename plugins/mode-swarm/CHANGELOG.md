# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Every version entry **at or below `16.5.2`** is inherited upstream oh-my-pi release history — not a veyyon release (see [UPSTREAM.md](../../UPSTREAM.md)). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Fixed

- A swarm file whose agent entry has no mapping (`writer:` with no fields) fails with `Agent 'writer' must be a mapping with 'role' and 'task'` instead of a `TypeError` reading `role` of null.

### Changed

- Cycle detection walks its queue by index instead of dequeuing with `Array.shift()`, so a swarm graph is checked in linear time. No user-visible behavior changes.

## [1.5.0] - 2026-09-18

### Changed

- Array copies that allocated with a spread now use `.slice()`, `.concat()` or `Array.from()`. No user-visible behavior changes.
- The package directory is `plugins/mode-swarm` instead of `packages/swarm-extension`; the published package name, entry points and behavior are unchanged.
- Doc comments refer to the runtime a swarm agent runs on as the agent infrastructure. No behavior change.

## [16.3.7] - 2026-07-05

### Fixed

- Fixed the peer dependency range for @veyyon/coding-agent to match the current ^16 major version.

## [15.9.0] - 2026-06-04

### Fixed

- Fixed swarm `/swarm run` failing with authStorage/modelRegistry identity error ([#1472](https://github.com/can1357/oh-my-pi/issues/1472))

## [1.3.0] - 2026-08-28

### Changed

- Swarm's documented agent tool inventory now names the canonical `search` and `eval` tools instead of retired workspace-search names. No runtime behavior changed.

## [1.2.0] - 2026-08-23

### Breaking Changes

- The minimum supported Bun runtime is now 1.4.0.
