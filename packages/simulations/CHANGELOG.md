# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Every version entry **at or below `16.5.2`** is inherited upstream oh-my-pi release history — not a veyyon release (see [UPSTREAM.md](../../UPSTREAM.md)). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Added

- New package. It holds simulations: suites that drive a real subsystem end to end against scripted, offline inputs, rather than asserting on a mocked seam. The first family, `src/turn-sim/`, runs a real `AgentSession` against a scripted provider and covers the failure shapes a component-level test cannot see, because they are hangs rather than wrong values: a provider that stops sending bytes mid-answer, a local tool that never returns, a stream that ends with a tool call still open, a model that will not stop, and an interrupted tool batch. Each scenario is awaited to completion, so removing the bound under test makes the suite time out instead of quietly passing.
