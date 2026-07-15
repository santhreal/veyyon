# Brand and identity

Cross-product identity is defined in the workspace [brand system](https://github.com/santhsecurity/veyyon/blob/main/docs/brand-system.md). This page is the handbook contract for how that identity appears in the Veyyon harness (CLI, TUI, packages, config paths, and docs).

## Product identity

| Item | Value |
| --- | --- |
| Product | Veyyon |
| CLI / TUI product name | Veyyon Code (user-facing harness) |
| Executable | `veyyon` |
| npm scope | `@veyyon/*` (for example `@veyyon/pi-coding-agent`) |
| Config home | `~/.veyyon` (override dir name with `PI_CONFIG_DIR`; Linux XDG via `veyyon config init-xdg`) |
| Profile env | `VEYYON_PROFILE` (also accepts legacy `OMP_PROFILE` / `PI_PROFILE`) |

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT): TypeScript and Bun for the agent loop and TUI, Rust natives for hot paths (grep, PTY, hashline edits). Features described with a `> **Spec — not shipped:**` callout are target design, not current behavior.

Legal provenance stays in `LICENSE`, `NOTICE`, `UPSTREAM.md`, and [Acknowledgements](../acknowledgements.md). OpenAI-compatible wire formats and upstream attribution are protocol or history facts, not active product branding.

## Interface palette

**Veyyon Dark** (`dark.json`) matches the brand system. **Light** (`light.json`) is still the upstream oh-my-pi palette until a silver light theme ships.

| Theme | Status | Ground | Primary text | Brand accent | Highlight |
| --- | --- | --- | --- | --- | --- |
| Veyyon Dark | Shipped | Pitch black `#000000` | `#FAFAFA` | Silver `#B8BDC7` | Deep blue `#4A84C9` |
| Light | Shipped (upstream) | Terminal / light gray chrome | Terminal default | Teal `#5a8080` | — |

> **Spec — not shipped:** Veyyon Light with `#FAFAFA` ground-inverse and silver `#B8BDC7` (brand-system target).

The ground is **pitch black**. On it, two colors do two clearly separate jobs:

- **Silver `#B8BDC7` is the brand accent** — the color you actually see. It carries the identity and all structure: the wordmark and marks, labels and kickers, rules and hairlines, focus and selection, progress, and **primary actions** (a primary button is silver/near-white, not blue). Silver is metallic and legible on black; keep it bright enough to read as silver, not dim gray.
- **Deep blue `#4A84C9` is a highlight only** — a sparing pop on the single thing that matters in a view: a key link, an active/selected state, the input caret, one accented word. Blue is **never** a primary fill, a dominant surface, or the default color of chrome. If more than a little blue is showing, it is being misused. When in doubt, use silver and let one blue accent stand out.

Green, red, and yellow accent objects when their meaning fits (success, error, warning). They do not replace silver or blue.

Supporting tones:

| Token | Value | Use |
| --- | --- | --- |
| Silver | `#B8BDC7` | Brand accent — structure, labels, marks, rules, primary actions |
| Silver bright | `#E1E4E9` | Emphasis and hover on dark surfaces; primary-action text ground |
| Silver dark | `#747B86` | Secondary structure and muted labels |
| Deep blue | `#4A84C9` | Highlight — one accent per view (link, active state, caret) |
| Blue bright | `#6BA3E8` | Link/highlight hover |

**Every background is pure black `#000000`.** There are no raised panels, no tinted surfaces, no elevated cards, no `#050505`/`#0A0A0A` "near-black" fills, and no colored state backgrounds (no reddish error fill, no gray selection fill). Every surface — page, card, terminal, panel, code block, status line, selected row, tool output — sits on the same pitch black. Separation and hierarchy come from **silver hairline borders and text color only**, never from a background fill. A selected or active element is shown with a silver rule, a caret (`›`), or brighter text — not a lighter background.

Cyan, orange, purple, and rainbow (multi-color) treatments are not Veyyon chrome. **No gradients and no glow** — not on surfaces, buttons, marks, or text. Edges are sharp.

## Onboarding and installers

Interactive terminals may show the Veyyon wordmark and silver progress when color is available. Piped and no-color output stays plain. Install and upgrade flows use Veyyon names and the `veyyon` executable only — no Codex/OpenAI product aliases, `~/.codex` paths, or hidden compatibility shims.

## Documentation contract

- Identity and palette: brand system + this page.
- Engine behavior: handbook pages reconciled to shipped code.
- **Spec — not shipped**: target design (self-contained profiles, top-level `veyyon doctor`, provider-hosted connectors) until a release ships it.

See also: [Themes and identity](../using/themes.md), [TUI design language](./tui-design-language.md).
