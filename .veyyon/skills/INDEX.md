# Maintainer skills

Ship-facing rituals for changelog, docs, screenshots, and demos. Open these when landing or proving a product change.

Every skill in this directory is listed below, in one of the two tables. The ship ritual is the first table; the owner-maintained prompt-authoring and evaluation skills are the second. Being in the second table means the skill is not part of the ship ritual and must not be expanded or "simplified" for agents, not that it is undocumented.

## Open this first

| When | Skill |
| --- | --- |
| Any change to what the TUI renders (component, layout, color, theme, animation) | [ui](ui/SKILL.md) |
| A feature or fix just landed and needs to be tracked | [ship-feature](ship-feature/SKILL.md) |
| Handbook, README, `--help`, SPEC, or CHANGELOG | [docs](docs/SKILL.md) |
| Settings off/on proof, gallery, or README still | [screenshots](screenshots/SKILL.md) |
| Any workflow GIF / VHS tape | [record-demo](record-demo/SKILL.md) |
| A demo that must show a Veyyon-unique capability | [prove-feature](prove-feature/SKILL.md) |
| System prompt tuning, flag overlays, and A/B benchmarks | [evals](evals/SKILL.md) |

## Owner-maintained

These are not steps in the ship ritual and `ship-feature` does not route to them. They are listed here so every skill directory is catalogued the same way: a skill that exists but appears in no table is one nobody can find and nobody maintains.

| When | Skill |
| --- | --- |
| Authoring or editing any prompt the model reads, including tool docs and agent definitions | [system-prompts](system-prompts/SKILL.md) |
| Auditing or trimming a built-in tool's description prompt against its parameter schema | [tool-prompt-optimization](tool-prompt-optimization/SKILL.md) |
| Compressing text for prompts, where grammatical scaffolding costs tokens the model reconstructs anyway | [semantic-compression](semantic-compression/SKILL.md) |

## Ritual order

`ship-feature` is the router. It calls the others in order: changelog and docs → settings differential → demo → gates. `prove-feature` is the bar for *which* demo is worth shipping when the change is a differentiator (Argot, hashline landing, and so on), not a generic ask/edit toy.

`ui` is a gate, not a step in that router: any change that alters what the TUI renders goes through it first. UI work leaves `main` (its own worktree) and cannot land without a before/after visual proof per theme and ground. Reach it before you edit a component, not after.

## Shared demo defaults

One place owns the pin and capture block: [record-demo](record-demo/SKILL.md) and `scripts/demos/launch.sh`.

- Profile: `work` (`VEYYON_DEMO_PROFILE`)
- Model: `google-antigravity/gemini-3.6-flash` with `--thinking high`
- Capture: the shared VHS block in record-demo (pure black, sharp corners)

Screenshots and prove-feature link there. Do not fork a second profile or theme.
