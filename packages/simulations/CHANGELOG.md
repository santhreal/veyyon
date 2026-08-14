# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Every version entry **at or below `16.5.2`** is inherited upstream oh-my-pi release history — not a veyyon release (see [UPSTREAM.md](../../UPSTREAM.md)). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Added

- New family `src/cache-sim/`, which prices a prompt-cache change before anyone makes one. It drives the shipped Anthropic request builder to capture the real wire body and the real breakpoints, then bills the result against a modelled provider cache (longest prefix of the arriving request wins, entries expire on the retention they were written with, published read/write multipliers). Scenarios: every counterfactual arm sends byte-identical content so a delta is never a comparison of two different prompts; a system block that changes each turn is measured against the shipped anchor and against a deeper one; a retention switch is priced across gap lengths and shown to have exactly one crossover; and a rewritten earlier message is shown to forfeit the whole history behind it while rewriting the newest message does not.

## [1.0.47] - 2026-08-13

### Added

- New package. It holds simulations: suites that drive a real subsystem end to end against scripted, offline inputs, rather than asserting on a mocked seam. The first family, `src/turn-sim/`, runs a real `AgentSession` against a scripted provider and covers the failure shapes a component-level test cannot see, because they are hangs rather than wrong values: a provider that stops sending bytes mid-answer, a local tool that never returns, a stream that ends with a tool call still open, a model that will not stop, and an interrupted tool batch. Each scenario is awaited to completion, so removing the bound under test makes the suite time out instead of quietly passing.
