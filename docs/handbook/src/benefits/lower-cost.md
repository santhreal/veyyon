# Lower token cost and faster turns

Veyyon treats cost as a product feature. The cheapest token is the one the model never has to spend.

Cost drops when the harness avoids retries, bounds tool output, keeps the working context small, preserves
cache-friendly continuity, and verifies before spending more turns. These are not separate tricks. They
compound.

## What improves

- Bounded `read`, `glob`, and `grep` tools prevent one call from flooding the context.
- Tool output says exactly when and how it was truncated.
- Compaction preserves the task state instead of dropping history silently.
- The deterministic file working set survives compaction.
- Reviewer hints and verification stop wasted turns before they become expensive loops.

## Why it matters

A long coding task fails when the model loses the plot. It also gets expensive when every tool call
returns more text than the next decision needs. Veyyon keeps the context focused on the files, failures,
and diffs that still matter.

## Where the details live

- [Performance](../why/performance.md) explains the product-level speed story.
- [Bounded reads and instant search](../context/reads-search.md) explains the tool-output bounds.
- [Compaction and project memory](../context/compaction-memory.md) explains long-task context.
- [Goal state](../context/goal-state.md) explains how the harness keeps long tasks coherent.
