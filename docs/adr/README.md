# Architecture decision records

Load-bearing decisions and *why* they were made, so the reasoning outlives the people
who were in the room. Each record is immutable once accepted — to change a decision,
add a new ADR that supersedes it.

- One file per decision: `NNNN-short-title.md`, numbered in order.
- Start from [`template.md`](template.md).
- Status is one of: proposed, accepted, superseded (by NNNN), deprecated.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-fork-from-oh-my-pi.md) | Fork oh-my-pi rather than build from scratch | accepted |
| [0002](0002-typescript-bun-not-rust.md) | Keep the product in TypeScript + Bun; Rust for hot paths only | accepted |
| [0003](0003-reset-versioning-to-1.0.0.md) | Reset veyyon's release line to 1.0.0 above the fork point | accepted |
