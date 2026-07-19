# Themes and identity

Veyyon's interface is built around near-black, near-white, and a persistent **Veyyon silver** accent (`#C6CBD4`).

## Bundled themes

| File | Name | Notes |
| --- | --- | --- |
| `defaults/titanium.json` | Titanium | **Default dark theme.** Pitch black `#000000`, silver `#C6CBD4`, ember accent `#F0862E`, matches the website tokens (`website/site.css`) |
| `dark.json` | Veyyon Dark | Pitch black `#000000` / `#FAFAFA` / silver `#B8BDC7`; predates the ember accent |
| `light.json` | Light | **Default light theme.** Titanium's inverse: white `#FFFFFF` ground, dark-silver structure `#5C6470`, ember accent (`#F0862E` chrome, `#B65E14` links), see `docs/internal/design.md` "Light ground" |

A larger bundled catalog ships under `modes/theme/defaults/` and is selectable from the theme picker.

## Changing theme

- **Settings UI:** `/settings` → Appearance → theme (or the theme picker on first run).
- **Config:** `theme` in `~/.veyyon/profiles/default/agent/config.yml` (profile-specific when using `--profile`).
- **Custom themes:** drop JSON under `~/.veyyon/profiles/default/agent/themes/`; schema in `docs/theme.md`.

Terminal capability detection maps the same hierarchy for truecolor, ANSI-256, ANSI-16, unknown background, and no-color modes. Reduced-motion settings remove decorative animation without hiding state changes.

## Painted ground

`tui.paintGround` (`/settings` → Appearance → Display) controls whether Veyyon sets the
terminal's own background color (OSC 11) to the theme's ground while it runs, so the UI
fills the window edge-to-edge instead of floating on the terminal's configured background.
The original background is restored on exit, including crash exits.

| Value | Behavior |
| --- | --- |
| `auto` (default) | Paint only when the terminal's reported background is already close to the theme ground, so no visible seam appears while painting. If the terminal doesn't report its background, inherit it. |
| `always` | Always paint the theme ground. |
| `never` | Never touch the terminal background. |

Terminals that don't support OSC 11 ignore the sequence; nothing breaks.

## What the theme covers

The contract applies to onboarding, composer, menus, dialogs, status line, markdown, tables, diffs, tool output, approvals, progress, and errors, not only the chat pane.

## Identity elsewhere

- CLI binary: `veyyon`
- Config root: `~/.veyyon` (`VEYYON_CONFIG_DIR`; XDG paths after `veyyon config init-xdg`)
- npm packages: `@veyyon/*`
