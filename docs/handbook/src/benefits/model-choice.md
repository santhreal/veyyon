# Model and provider selection

The agent loop is provider-neutral. Point it at a local server, a direct provider API, or a compatible gateway. The harness selects wire format, prompts, and tool exposure from the model catalog and settings.

## Behavior

- Provider and model metadata live in the catalog, not hard-coded per call site
- Per-model prompt section order and tool allowlists can be set via harness profiles
- Explicit pin: `/model`, `--model`, and `config.yml`
- Tool repair, edit verification, goal/context handling, and output bounds apply regardless of vendor

## Details

- [Models and providers](../using/models.md)
- [Providers](../models/providers.md)
- [Execution-order prompts](../models/prompts.md)
- [Per-model repair posture](../repair/per-model.md)
