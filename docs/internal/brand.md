# Brand and identity

This page is the identity contract for the Veyyon harness (CLI, TUI, packages, config paths, docs). The shipped website (`website/`) is the reference implementation of the visual system — when this page and the website disagree, the website wins and this page gets fixed.

## Product identity

| Item | Value |
| --- | --- |
| Product name | **Veyyon** (only name — not "Veyyon Code") |
| Primary command | `veyyon` |
| Short alias | `vey` |
| npm scope | `@veyyon/*` (e.g. `@veyyon/coding-agent`) |
| Config home | `~/.veyyon` (`VEYYON_CONFIG_DIR`) |
| Profile env | `VEYYON_PROFILE` |

Veyyon forks [oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT): TypeScript/Bun agent loop and TUI, Rust natives for hot paths (grep, PTY, hashline). Upstream provenance is license and history — not a tagline to paste into Veyyon UI or docs.

Features marked `> **Spec — not shipped:**` are target design, not current behavior.

Legal provenance: `LICENSE`, `NOTICE`, `UPSTREAM.md`, [Acknowledgements](../handbook/src/acknowledgements.md). OpenAI-compatible wire formats are protocol facts, not product branding.

## Voice

Exact, restrained, technical. Name the product **Veyyon**. Prefer short factual sentences. No inherited slogans ("IDE wired in"), no second product name for the CLI, no mascot language, no unbacked capability claims.

## Interface palette

**Titanium** (`titanium.json`, under `src/modes/theme/defaults/`) is the shipped **default** dark theme (`theme.dark` defaults to `titanium`; `theme.light` defaults to `light`). **Veyyon Dark** (`src/modes/theme/dark.json`) is a pre-ember silver-accent alternative. **Light** (`src/modes/theme/light.json`) is now the brand light theme: white ground, silver text, ember accent. A large additional builtin catalog ships alongside them in `defaults/` (`dark-*`/`light-*` ports plus material names like `obsidian`, `basalt`, `pearl`); those are user options, not brand surfaces.

| Theme | Status | Ground | Primary text | Structure | Accent |
| --- | --- | --- | --- | --- | --- |
| Titanium (default) | Shipped | Pitch black `#000000` | Silver bright `#E6E9EE` | Silver `#C6CBD4` | Ember `#F0862E` |
| Veyyon Dark | Shipped | Pitch black `#000000` | Terminal default | Silver `#B8BDC7` | Silver `#B8BDC7` (pre-ember; blue `#4A84C9` remains a secondary color) |
| Light | Shipped | White `#FFFFFF` | Silver strong `#343B45` | Silver `#5C6470` | Ember `#F0862E` (glow `#FBE9D9`) |

The ground is **pitch black**. On it, two colors do two jobs — the same system the website ships (`website/site.css` `:root` tokens):

- **Silver is structure** — wordmark, labels, hairlines, progress, primary text hierarchy: `#C6CBD4` / bright `#E6E9EE` (same value on both surfaces).
- **Ember is the single accent** — the sun: `#F0862E`, carried on the website by links, hover `#FB9E44`, and the focus ring; in the TUI (titanium) by links, the accent border, list bullets, and the selection glow (`emberDim #B8632A`, `emberGlow #241510`). One accent per view; never a primary fill.

Green, amber, and red only when meaning fits (success, warning, error): `#7FB98A` / `#C9A24B` / `#C96F6E` on both surfaces. Ember is the brand accent and stays distinct from the amber warning color. `website/site.css` `:root` is the canonical token source; the titanium theme mirrors it, locked by `test/brand-conformance.test.ts` (site.css parity test).

**Every background is pure black `#000000`.** Hierarchy comes from silver hairlines, text weight, and the ember accent — not raised panels or tinted fills. No cyan/purple/rainbow chrome. No gradients. Sharp edges. The only permitted glow is the ember selection tint (`emberGlow`).

Known drift (tracked in `BACKLOG.md`): `dark.json` (Veyyon Dark) predates the ember accent entirely (silver accent, blue secondary).

## Onboarding and installers

Fullscreen setup: Veyyon wordmark + silver progress. No secondary product name and no upstream tagline under the mark. Install/upgrade copy uses **Veyyon**, commands `veyyon` / `vey` only.

Session welcome is a single hero card (not a dual-column dashboard): wordmark, one value line (`Hashline edits that land. Your keys.`), action rows with right-aligned shortcuts, optional recent sessions. Settings is a width-capped centered panel.

## Documentation contract

- Identity and palette: brand system + this page.
- Engine behavior: handbook pages reconciled to shipped code.
- **Spec — not shipped**: target design until a release ships it.

See also: [Themes and identity](../handbook/src/using/themes.md), [TUI design language](./tui-design-language.md).

*Verified against `7ca44d3` on 2026-07-17.*
