# Testing and verification

Veyyon's docs make product claims only when the harness has a way to prove them. This chapter explains the
shape of that proof so the detailed pages are easier to read.

## What a proof looks like

A proving test asserts behavior, not just shape. For a file edit, that means the exact file bytes, the diff,
the error text, and the approval path when relevant.

## Where the main proof lives

- The hashline edit path uses round-trip tests so generated patches apply to the intended content.
- Tool-output bounds are tested with real limits so truncation is visible and actionable.
- Architecture gates protect layering, re-exports, weak tests, uncovered tools, unfinished markers, and vendored
  trees.

> **Spec — not shipped:** the full schema-based repair cascade is a planned proof surface. Its target
> shape is exact-value unit tests plus large property tests that validate repaired calls against the
> schema, including whether ambiguous input is rejected. That work is not shipped yet.

## How to read status labels

The status label at the top of a deep-dive chapter names the implemented surface and the proof. When a
chapter says work is in progress, it names the part that works and the part still gated by measurement or
operator surface.

## Where to go next

- [The repair cascade](../repair/cascade.md) shows the planned repair rules and their proof style (Spec).
- [The hashline edit engine](../edit/engine.md) shows edit invariants.
- Fleet verification gates are defined in the Santh `STANDARD.md` document (not duplicated here).
