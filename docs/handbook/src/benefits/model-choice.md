# Model choice without lock-in

Veyyon's terminal engine is provider and API agnostic. You can point it at a local server, a direct
provider API, or a compatible gateway. In every path, the harness adapts to the selected API and model
instead of forcing every model through one generic shape.

## What improves

- Provider details live in a data catalog, not scattered through code.
- Each backend gets the wire API and edit form it can actually carry.
- Per-model prompt order and tool exposure are assembled from the catalog.
- You can pin a specific model when you want explicit control.
- Provider-agnostic improvements such as tool repair, path repair, edit verification, goal/context handling,
  prompt profiles, and output bounds work with any compatible API you choose.

## Why it matters

Open models are not interchangeable. A model that is strong at one language or patch shape can be weak at
another. A generic harness hides those differences and pays for them in retries. Veyyon makes the
differences explicit and uses them.

## Where the details live

- [Models and providers](../using/models.md) explains the user-facing model choice.
- [Providers](../models/providers.md) explains model and provider configuration.
- [Execution-order prompts](../models/prompts.md) explains the prompt shape.
- [Per-model posture](../repair/per-model.md) explains per-model repair posture via harness profiles (bounded repair telemetry is spec, not shipped).
