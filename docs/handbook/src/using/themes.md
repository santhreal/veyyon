# Themes and identity

Veyyon's interface is built around near-black, near-white, and a persistent **Veyyon silver** accent (`#C6CBD4`).

## Shipped themes

| File | Name | Notes |
| --- | --- | --- |
| `defaults/titanium.json` | Titanium | **Default dark theme.** Pitch black `#000000`, silver `#C6CBD4`, ember accent `#F0862E` — matches the website tokens (`website/site.css`) |
| `dark.json` | Veyyon Dark | Pitch black `#000000` / `#FAFAFA` / silver `#B8BDC7`; predates the ember accent |
| `light.json` | Light | **Default light theme.** Titanium's inverse: white `#FFFFFF` ground, dark-silver structure `#5C6470`, ember accent (`#F0862E` chrome, `#B65E14` links) — see `docs/internal/design.md` "Light ground" |

A larger bundled catalog ships under `modes/theme/defaults/` and is selectable from the theme picker.

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
