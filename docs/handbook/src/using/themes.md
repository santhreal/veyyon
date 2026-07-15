# Themes and identity

Veyyon Code's interface is built around near-black, near-white, and a persistent **Veyyon silver** accent (`#B8BDC7`).

## Shipped themes

| File | Name | Notes |
| --- | --- | --- |
| `dark.json` | Veyyon Dark | Rebranded: `#050505` / `#FAFAFA` / silver `#B8BDC7` |
| `light.json` | Light | Upstream oh-my-pi palette (teal accent); not yet silver-rebranded |

> **Spec — not shipped:** Veyyon Light with inverted black/white poles and a persistent silver accent.

## Changing theme

- **Settings UI:** `/settings` → Appearance → theme (or the theme picker on first run).
- **Config:** `theme` in `~/.veyyon/agent/config.yml` (profile-specific when using `--profile`).
- **Custom themes:** drop JSON under `~/.veyyon/agent/themes/`; schema in `docs/theme.md`.

Terminal capability detection maps the same hierarchy for truecolor, ANSI-256, ANSI-16, unknown background, and no-color modes. Reduced-motion settings remove decorative animation without hiding state changes.

## What the theme covers

The contract applies to onboarding, composer, menus, dialogs, status line, markdown, tables, diffs, tool output, approvals, progress, and errors — not only the chat pane.

## Identity elsewhere

- CLI binary: `veyyon`
- Config root: `~/.veyyon` (`PI_CONFIG_DIR` overrides the directory name; XDG paths after `veyyon config init-xdg`)
- npm packages: `@veyyon/*`

Full brand rules: [Brand and identity](../design/brand.md) and the repo `docs/brand-system.md`.
