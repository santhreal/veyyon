# Maintainer skills

Ship-facing rituals for changelog, docs, screenshots, and demos. Open these when landing or proving a product change.

Prompt-authoring skills in this directory (`system-prompts`, `tool-prompt-optimization`, `semantic-compression`) are owner-maintained. Do not treat them as part of the ship ritual, and do not expand or “simplify” them for agents.

## Open this first

| When | Skill |
| --- | --- |
| A feature or fix just landed and needs to be tracked | [ship-feature](ship-feature/SKILL.md) |
| Handbook, README, `--help`, SPEC, or CHANGELOG | [docs](docs/SKILL.md) |
| Settings off/on proof, gallery, or README still | [screenshots](screenshots/SKILL.md) |
| Any workflow GIF / VHS tape | [record-demo](record-demo/SKILL.md) |
| A demo that must show a Veyyon-unique capability | [prove-feature](prove-feature/SKILL.md) |

## Ritual order

`ship-feature` is the router. It calls the others in order: changelog and docs → settings differential → demo → gates. `prove-feature` is the bar for *which* demo is worth shipping when the change is a differentiator (Argot, hashline landing, and so on), not a generic ask/edit toy.

## Shared demo defaults

One place owns the pin and capture block: [record-demo](record-demo/SKILL.md) and `scripts/demos/launch.sh`.

- Profile: `work` (`VEYYON_DEMO_PROFILE`)
- Model: `google-antigravity/gemini-3.6-flash` with `--thinking high`
- Capture: the shared VHS block in record-demo (pure black, sharp corners)

Screenshots and prove-feature link there. Do not fork a second profile or theme.
