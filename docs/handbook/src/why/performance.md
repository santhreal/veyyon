# Performance

Speed in a coding agent is not one number. It is the sum of many small choices: how often a change
lands on the first try, how much text the model has to emit, how quickly the harness gets out of the
way. Veyyon is built so those choices add up in your favor. This page explains what that means for you.

## Fewer wasted round trips

The largest cost in an agent is not the model thinking. It is the model redoing work. A malformed tool
call, a bad diff, a value in the wrong shape: each one normally costs a full extra round trip, where
the model receives an error, apologizes, and tries again. Veyyon repairs the common mistakes before
they reach you, so the work lands on the first attempt. Fewer round trips means a faster answer and a
smaller bill.

## An edit format that does not fight the model

When the edit format is hard to emit correctly, a weak model burns its turns on retries and its budget
on extra output. Veyyon uses an edit format that open models produce reliably, and it normalizes and
applies edits in a single pass over the file, so editing a large file with many changes stays fast as
the file grows.

## A harness that gets out of the way

Veyyon is a lightweight Bun and TypeScript harness with Rust natives on the hot paths (grep, PTY,
hashline edits). It starts quickly, it streams output as it arrives, and it does the internal
bookkeeping of a turn without copying your data more than once. The work the harness does between you
and the model is kept to the minimum, so the time you wait is the model's time, not the harness's.

## Measured, not asserted

Every speed claim in Veyyon is backed by a benchmark that runs on every change. A change that would
make a hot path slower fails the build before it ships. We hold even a correct fallback path to a speed
bound, because a path that is correct but slow is still a path that wastes your time. The internal
record of each change and its measurement is kept by the team and is not part of this public book, but
the rule it follows is stated here: a performance claim that is not measured is not made.

## What this adds up to

A clean edit format, automatic repair, a control flow that stops when the work is done, and a harness
that copies nothing it does not have to. Individually each is small. Together they are the difference
between an agent that feels heavy and one that feels instant, at a fraction of the cost of a frontier
model.

## Where to go next

- [What makes Veyyon different](./innovations.md) is the design behind these gains.
- [Getting started](../using/getting-started.md) puts it to work.
