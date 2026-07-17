# 0002. Keep the product in TypeScript + Bun; Rust for hot paths only

- **Status:** accepted
- **Date:** 2026-07-16

## Context

veyyon is ~665k lines of non-test TypeScript (plus ~427k lines of TS tests) and ~173k
lines of Rust across nine crates. The TypeScript is the entire product surface: the
agent loop, the differential-rendering TUI, the multi-provider streaming client, the
tool engine, MCP, the model catalog, modes, commands. The Rust is only the
performance-critical natives — grep, PTY, shell, text/AST — reached from TS through a
napi addon.

The question raised: should veyyon migrate fully to Rust (cargo) instead of Bun?

## Decision

No. The product stays TypeScript + Bun. Rust stays scoped to hot paths, grown
incrementally where profiling justifies it.

## Consequences

- Iteration speed stays high on the parts that change most — agent behavior and UX.
- Bun-specific APIs (`Bun.file`, Bun Shell, `bun:sqlite`, `Bun.stringWidth`, single-file
  `--compile`, the worker-reentry model) remain load-bearing; that dependency is
  accepted.
- Performance work means pushing *profiled* bottlenecks down into the existing crates,
  not rewriting product logic in Rust.

## Alternatives considered

- **Full Rust rewrite.** Rejected: it is not a migration but a ground-up rewrite of
  ~665k lines of product logic (and ~427k of tests) with no mature Rust equivalents for
  the TUI renderer, provider-dialect layer, MCP client, or mode/tool system. Multi-
  person-year cost, discarding a working and tested feature set, in exchange for
  performance the current split already captures where it matters.
