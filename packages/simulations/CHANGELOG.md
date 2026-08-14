# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Every version entry **at or below `16.5.2`** is inherited upstream oh-my-pi release history — not a veyyon release (see [UPSTREAM.md](../../UPSTREAM.md)). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Added

- New family `src/cache-sim/`, which prices a prompt-cache change before anyone makes one. It drives the shipped Anthropic request builder to capture the real wire body and the real breakpoints, then bills the result against a modelled provider cache (longest prefix of the arriving request wins, entries expire on the retention they were written with, published read/write multipliers). Scenarios: every counterfactual arm sends byte-identical content so a delta is never a comparison of two different prompts; a system block that changes each turn is measured against the shipped anchor and against a deeper one; a retention switch is priced across gap lengths and shown to have exactly one crossover; and a rewritten earlier message is shown to forfeit the whole history behind it while rewriting the newest message does not.
- `src/cache-sim/` also runs a fleet: several sessions billed against one shared cache, interleaved by simulated time, which is the only shape in which the shipped anchor's justification can be measured. It prices the trade between anchoring the first system block (so a subagent can read the harness its parent cached) and anchoring one block deeper (so a parent with a changing system tail stops re-reading everything in between), and reports the fan-out at which the shallow anchor breaks even. It also shows that an entry is invisible to another session unless its marker carries `scope: "global"`, which no code path sets, so today that break-even is never reached at any fan-out.
- The fleet scenario also prices its own recommendation under an adverse assumption: no published number says what a shared cache write costs, so the modelled cache takes a `globalWritePremium` and the scenario re-runs the switch as if a shared write cost the dearest write in the table. Sharing still wins from one subagent, and scoping every system marker rather than the anchor loses outright, because the deepest system marker sits on a block that changes every turn.

## [1.0.47] - 2026-08-13

### Added

- New package. It holds simulations: suites that drive a real subsystem end to end against scripted, offline inputs, rather than asserting on a mocked seam. The first family, `src/turn-sim/`, runs a real `AgentSession` against a scripted provider and covers the failure shapes a component-level test cannot see, because they are hangs rather than wrong values: a provider that stops sending bytes mid-answer, a local tool that never returns, a stream that ends with a tool call still open, a model that will not stop, and an interrupted tool batch. Each scenario is awaited to completion, so removing the bound under test makes the suite time out instead of quietly passing.
