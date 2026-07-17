# Model contract

The terminal engine is provider/API agnostic. You choose an endpoint, choose a model when that endpoint
exposes model choice, provide the key, and Veyyon calls that API directly. The endpoint can be a local
server, a direct provider API, or a compatible gateway.

The full contract — what you bring (endpoint, model, key), what the harness owns, Freeform vs Function
tools, and mid-session switching rules — lives in
[Model contract](../concepts/model-contract.md).

For BYOK providers, model and provider entries are data. Veyyon can discover compatible models, merge
operator-configured providers, and reject malformed provider data at load time.

## What stays constant

- The workflow stays the same: read, edit, verify, and stop when the work is done.
- Tool repair, edit verification, sandboxing, approvals, and context handling are harness behavior.
- You are not locked to any provider; point the harness at any compatible API.

## Next

- [Models and providers](./models.md) — day-to-day switching and comparison guidance.
- [Configuring providers](./configuring-providers.md) — copy-paste setups.
- [Safety](./safety.md) — boundaries around tool use and model output.
