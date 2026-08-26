# Arms Reference

Configuration arms are overlays in `arms/<name>.yml` that the runner applies on top of the default veyvon configuration. Each arm changes one variable so comparisons are single-variable and attributable.

## Arm files

An arm consists of one or more files:

| File | Purpose |
|---|---|
| `<name>.yml` | Configuration overlay (feature flags, settings) |
| `<name>.sections.yml` | Prompt section overrides |
| `<name>.statements.yml` | Prompt statement overrides or ablations |
| `<name>.prompts.yml` | Prompt registry item overrides (tool descriptions, subagent prompts) |
| `<name>.rule.md` | Behavioral rule file |

The arm fingerprint covers all files. Two arms with identical `.yml` but different `.sections.yml` are distinct and will not collide.

## Available arms

### baseline

Default configuration with argot disabled. The control arm for all comparisons.

```yaml
argot:
  enabled: false
```

### argot-setting-only

Argot enabled but no encoding model allowlisted. Isolates the cost of the feature being enabled and loadable without any teaching in the prompt.

```yaml
argot:
  enabled: true
```

### candidate-argot-nudge

Argot enabled with a behavioral rule that nudges the model to use shorthand. Paired with `argot-setting-only` to measure the nudge's effect independently of the feature flag.

```yaml
argot:
  enabled: true
```

Plus `arms/candidate-argot-nudge.rule.md`.

### full

Full argot pipeline: encode + decode. The model is taught the notation preamble, loads the project dictionary with `argot_load`, writes handles, and the harness expands them at every seam.

```yaml
argot:
  enabled: true
  encode:
    models:
      - gemini-3.5-flash
```

The `encode.models` list must name the resolved logical model id, not a display alias. The encode gate matches against the model after the catalog resolves it.

### full-budget16k

Full arm with a 16k token dictionary budget. Paired with `full` to measure the effect of a larger dictionary.

### decode

Decode-only: the codec is enabled and the agent may load a project's dictionary, but no model is allowed to encode. The notation preamble is never taught and the model is never shown handles. Expansion (decode) stays armed.

```yaml
argot:
  enabled: true
  encode:
    models: []
  subagents: off
```

### decode-budget16k

Decode arm with a 16k token dictionary budget.

### candidate-bash-trim

Overrides the `tools/bash` prompt description to a trimmed version. The `.yml` file is intentionally identical to `baseline.yml`; the experiment lives in `candidate-bash-trim.prompts.yml`.

### candidate-delivery-terse

Overrides the delivery prompt section to a terse version. The `.yml` file is intentionally identical to `baseline.yml`; the experiment lives in `candidate-delivery-terse.sections.yml`.

### candidate-ablate-delegation-gates

Ablates specific delegation-gate statements by setting them to `null` in `candidate-ablate-delegation-gates.statements.yml`. Measures the effect of removing delegation guardrails.

### search-medium

Sets a per-model default effort level. Used for paired code-change evaluations where the model and effort are explicit.

```yaml
argot:
  enabled: false
defaultEffort:
  google-antigravity/gemini-3.7-flash: medium
```

### Spill and signature arms

Arms prefixed with `spill` or `sig` control context window management:

| Arm | Variable |
|---|---|
| `spill-control` | Context spill control settings |
| `spill-tight` | Tighter spill thresholds |
| `spill2kb` | 2KB spill threshold |
| `sig-last8` | Signature: last 8 messages |
| `sig-last1` | Signature: last 1 message |
| `sig-max4000` | Signature: max 4000 tokens |
| `sig4000-spill2kb` | Signature 4000 + 2KB spill |
| `think-last1` | Thinking: last 1 message |

## Authoring a new arm

1. Create `arms/<name>.yml` with the configuration overlay. Only include keys that differ from the default.
2. If the arm overrides a prompt section, create `arms/<name>.sections.yml`.
3. If the arm overrides a prompt statement, create `arms/<name>.statements.yml`.
4. If the arm overrides a prompt registry item, create `arms/<name>.prompts.yml`.
5. If the arm adds a behavioral rule, create `arms/<name>.rule.md`.
6. Validate with `bun run.ts --arms <name> --dry-run`.

### Single-variable principle

Each arm changes exactly one variable. If an arm flips a feature flag AND changes a prompt section, the delta has two causes and is unattributable. The `.yml` files for prompt-only arms are intentionally identical to `baseline.yml` — the experiment lives in the companion file.

The runner's zero-variable collision check rejects two arms with identical fingerprints. The fingerprint covers all files (config, sections, statements, prompts, rule), so arms with identical `.yml` but different companion files are distinct.
