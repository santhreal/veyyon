# Context size and retries

Token use and turn count depend on tool output size, compaction, and whether bad edits or tool JSON force retries.

## Mechanisms

- Bounded `read`, `glob`, and `grep` outputs (truncation is marked in tool results)
- Compaction (`summary` or `handoff`) compresses older history instead of dropping it silently
- Goal mode keeps an objective outside the raw transcript tail
- Edit verification and tool repair reduce failed apply/schema turns

## Details

- [Bounded reads and search](../context/reads-search.md)
- [Compaction and project memory](../context/compaction-memory.md)
- [Goal state](../context/goal-state.md)
- [Performance](../why/performance.md)
