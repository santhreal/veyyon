# 0001. Fork oh-my-pi rather than build from scratch

- **Status:** accepted
- **Date:** 2026-07-16

## Context

veyyon needed a terminal coding agent with a mature harness, agent loop, TUI, provider
integrations, tools, sessions, MCP. Building that from zero is a multi-year effort
before reaching parity with existing tools. [oh-my-pi](https://github.com/can1357/oh-my-pi)
is MIT-licensed and already implements this surface well.

## Decision

Fork oh-my-pi as veyyon's source base. Rebrand and diverge from there, preserving the
MIT attribution and fork provenance (`LICENSE`, `NOTICE`, `UPSTREAM.md`).

## Consequences

- veyyon inherits a working, tested harness and can spend effort on its own direction
  (brand, install flow, model-slot design, deployment) instead of reimplementing base
  mechanics.
- The inherited history has to be handled honestly: the per-package changelogs carry
  oh-my-pi's release history, marked as upstream, not veyyon's (see
  [ADR 0003](0003-reset-versioning-to-1.0.0.md)).
- Ongoing debranding is required: stale `omp`/`pi-mono` names in code, docs, and CI are
  tracked as findings until gone.
- Upstream fixes can be selectively ported; veyyon is not obligated to track upstream.

## Alternatives considered

- **Build from scratch.** Rejected: years to parity for no near-term differentiation.
- **Depend on oh-my-pi as an upstream package.** Rejected: veyyon needs to change core
  surfaces (branding, install, model selection, packaging) that a dependency boundary
  would not allow.
