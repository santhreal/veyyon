# Why repair exists

> **Status: Shipped (basic fix-if-clear).** Schema-based tool-call repair runs in the agent loop
> before validation. The full multi-rule cascade, telemetry, and per-shape backends remain **Spec —
> not shipped** — see [The repair cascade](./cascade.md).

OSS backends malform tool-call arguments in model-specific ways: stringified JSON, truncated JSON,
trailing commas, ambiguous field names. Each malformation, left alone, costs a whole turn.

**Repair makes recoverable calls land on the first attempt.** It coerces malformed-but-clear JSON
into an object and re-validates; when a call genuinely cannot be made valid, it fails **loud** back
to the model with coaching, never dispatched as garbage.

## The lever

*Edit format / first-attempt success.* Repair is the safety net under every schema-bearing tool call,
most importantly the **edit** path, where a malformed call is a failed edit.

## Shipped behavior

- **Seam:** argument repair runs in the agent loop, before argument validation.
- **Fix-if-clear:** trailing commas, parse sentinels (`__parseError` / `__rawJson`), stringified JSON objects.
- **Refuse-if-ambiguous:** missing required strings with multiple plausible sources → unrepairable (no invent).
- **Bounded:** inputs over 1 MiB refuse repair.
- **Disable:** `VEYYON_REPAIR_DISABLE=1` or per-model `harness.profiles` with `repair: false`.

## Not shipped yet

- Full ordered rule cascade (alias maps, strict unknown-key rejection, per-tool shape tables)
- Per-`(model,tool,shape)` telemetry store
- A large conformance suite extending the shipped TypeScript repair module
  (`packages/coding-agent/src/repair/schema-repair.ts`) at the tool-dispatch seam — this stays a TS
  module, not a separate Rust crate

See [The repair cascade](./cascade.md), [Per-model posture](./per-model.md), and
[Soundness and telemetry](./soundness.md) for the target design. For the shipped edit engine,
see [The hashline edit engine](../edit/engine.md).
