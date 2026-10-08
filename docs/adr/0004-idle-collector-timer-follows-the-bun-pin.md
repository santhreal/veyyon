# 0004. Bun's idle collector timer is fixed by the runtime pin, not in process

- **Status:** accepted
- **Date:** 2026-10-04

## Context

Bun 1.4.0 runs a repeating collector timer beside JavaScriptCore's allocation pacing
(`src/jsc/GarbageCollectionController.rs` at `bun-v1.4.0`). The timer requests an asynchronous
collection every second, and slows to one every 30 seconds after 30 consecutive ticks that read the
same `blockBytesAllocated()`. The comparison is exact equality, so a heap that shrinks restarts the
count as a heap that grows does. A collection that frees compiled code that has aged out changes the
value, and so does each collection after the idle trim's `Bun.shrink()`. Every tick wakes the seven
`HeapHelper` marker threads.

Measured on the split linux-x64 binary, interactive session with a credential, nothing typed: about
100 context switches a second from launch until about 100 s, then 1 a second with one collection
every 30 s. After a turn, the fast phase ends 105 to 115 s after the turn.

`BUN_GC_TIMER_DISABLE` and `BUN_GC_TIMER_INTERVAL` are read when the VM is created, before the entry
module runs. The process cannot set them for itself. The installer starts the binary directly:
`vey` is a symbolic link to `veyyon`, so nothing on the shipped launch path sets an environment
variable first.

## Decision

Veyyon makes no in-process change to the timer. The fix is in Bun: 1.4.1 compares the heap against
a growth slack and counts a shrinking heap as quiet, and Bun main adds idle full collections
(`BUN_IDLE_GC_SECONDS`). The pin in `package.json` moves past 1.4.0 on the first stable Bun release
that fixes oven-sh/bun#43856, the `bun test --isolate` heap corruption that blocks 1.4.1 and 1.4.2.
The idle measurement above is repeated on that release.

## Consequences

- An idle session runs the 1 Hz collector for about 100 s after launch and after each turn. Over
  the first 100 s the process uses 390 ms of CPU, against 180 ms with the timer disabled.
- First-frame latency, settled RSS and the idle trim's memory reduction stay as they are.
- The next Bun bump carries the idle wakeup measurement in its evidence, next to the binary size,
  launch and RSS figures.

## Alternatives considered

- **`BUN_GC_TIMER_DISABLE=1` in the launching environment.** The 25 s window falls from 132 to 27
  switches a second, the 60 s window from 106 to 1.7, and CPU over 100 s from 390 to 180 ms, with
  RSS at 100 s unchanged at 141.3 MiB. Rejected: the shipped launch path has no step that sets it.
- **Re-exec through `process.execve` with the variable set.** Rejected: the re-exec costs one more
  runtime start, 16.2 ms median end to end for `--version`, on a 37 ms first frame.
- **`--compile-exec-argv="--env-file=<path>"` at build time.** The file sets the variable in
  `process.env`, and the timer keeps running. On a compiled 1.4.0 binary holding 200,000 objects,
  a 10 s idle window costs 9.9 to 11.2 ms of CPU without the file, 10.8 to 11.9 ms with it, and 1.0
  to 1.1 ms with the variable in the launching environment. An env file embedded in the binary
  (`/$bunfs/root/<file>`) is not loaded at all. Rejected: no effect.
- **A different idle trim.** From launch, with the trim at 30 s: no trim ends the fast phase at
  70 s, `Bun.gc(true)` at 90 s, and both the shipped `Bun.shrink()` and `Bun.shrink()` followed by
  `Bun.gc(true)` at 110 s. Parking every JavaScript timer right after the trim ends it 112 to 115 s
  after the last turn. Rejected: none comes within 40 s of the last activity, and dropping the trim
  gives up its RSS reduction (374 to 349 MiB after eight turns).
- **Pin Bun 1.4.2 now.** After a turn, 1.4.2 takes 1,100 to 1,400 helper wakeups per 20 s against
  1,800 to 2,300 on 1.4.0. Rejected while `bun test --parallel` corrupts the heap under 1.4.1 and
  1.4.2 (oven-sh/bun#43856).
- **Compile the binary with 1.4.2 and test with 1.4.0.** Rejected: the shipped binary would run a
  runtime the test suite never ran.
