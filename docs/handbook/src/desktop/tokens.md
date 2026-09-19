# Tokens and themes

The desktop front end visual properties are defined in TOML configuration files.
These files set spacing, corner radii, typography, strokes, elevation, motion,
surface geometry, and color roles.

## File locations

Token files are stored in `crates/veyyon-desktop-tokens/`:

```text
tokens/
├── scale.toml
├── elevation.toml
├── motion.toml
├── ceilings.toml
└── surface/
    ├── shell.toml
    ├── breakpoints.toml
    ├── queue.toml
    ├── transcript.toml
    ├── composer.toml
    ├── panels.toml
    ├── palette.toml
    ├── attached-cards.toml
    └── settings.toml
themes/
├── dark.toml
└── light.toml
```

## Named scale references

`scale.toml` defines discrete scales for dimensions, curves, typography, and rules.
Surface configuration files reference these values by step name rather than
declaring raw pixel numbers.

The loader resolves the following token kinds:

| Token kind | Scale section | Step names | Disallowed input |
| --- | --- | --- | --- |
| Spacing | `[spacing]` | `s0` through `s13` | Numeric literals (`4`, `8.0`) |
| Corner radius | `[radius]` | `none`, `xs`, `sm`, `md`, `lg`, `xl`, `xxl`, `full` | Numeric literals (`8`, `14.0`) |
| Typography size | `[type.size]` | `micro`, `small`, `body`, `read`, `head`, `lead` | Numeric literals |
| Typography weight | `[type.weight]` | `regular`, `medium`, `semibold` | Numeric literals |
| Stroke width | `[stroke]` | `hairline`, `icon`, `heavy` | Numeric literals (`1.0`) |
| Icon box | `[icon.size]` | `size12`, `size14`, `size16`, `size20` | Numeric literals (`16`) |

When a surface configuration file specifies a raw integer or float for a key that
requires a scale token, the loader rejects the file with a `NumericLiteralDisallowed`
error. The error message reports the offending key, the supplied number, and an
example of an accepted step name.

Specifying an unrecognised step string reports an `UnresolvedReference` or
`OffScale` error naming the target file and the permitted step identifiers.

## Configuration files

### scale.toml

`scale.toml` sets the foundational measurement scales.

- `[spacing]`: Maps steps `s0` through `s13` to pixel values. The ceiling is 16 steps.
- `[radius]`: Maps steps `none` through `full` to corner radius values. The ceiling is 8 steps.
- `[type.size]`: Sets `size`, `line_height`, and `tracking_em` for each of the six type steps. The ceiling is 6 sizes.
- `[type.weight]`: Sets font weight integers (400, 500, 600) for `regular`, `medium`, and `semibold`. The ceiling is 3 weights.
- `[type.mono]`: Sets `size` and `line_height` for monospace type steps `small` and `body`.
- `[type.family]`: Declares ordered fallback lists of font family names for monospace text (`mono`) and general UI text (`ui`). The first installed family found on the operating system is selected.
- `[stroke]`: Sets line widths for `hairline`, `icon`, and `heavy` outlines.
- `[icon.size]`: Sets the bounding box an icon draws in for `size12`, `size14`, `size16`, and `size20`. The ceiling is 4 boxes.

### elevation.toml

`elevation.toml` defines the five elevation levels from ground to floating overlays:

- Level 0 (`shell_ground`): Window background. Specifies blue-noise background grain texture, tile dimensions, and opacity.
- Level 1 (`queue_rail`): Sidebar ground with a hairline right boundary.
- Level 2 (`canvas`): Primary content area for the transcript.
- Level 3 (`inset`): Recessed surfaces with hairline borders on all edges.
- Level 4 (`float`): Overlays including menus, pickers, and popovers. Configures backdrop blur radius, saturation multiplier, ground opacity, border placement, and box shadow parameters (x offset, y offset, blur, spread, opacity).

A key is permitted only when its corresponding capability flag (`grain_enabled`,
`blur_px > 0`, or `has_shadow`) is active. Declaring shadow values on a level where
`has_shadow = false` fails validation.

### motion.toml

`motion.toml` sets animation parameters for interface roles:

- `[role.tint]`: Background color transitions on hover and focus. Uses a duration model with easing curve.
- `[role.reveal]`: Progressive disclosure of blocks. Uses a spring oscillator model.
- `[role.float]`: Palette and modal appearances. Combines vertical rise, opacity fade, and a spring oscillator.
- `[role.panel]`: Resizable panels and drawers. Combines direct pointer tracking with a settling spring oscillator.
- `[role.shift]`: Structural layout repositioning. Uses a layout transition model.
- `[role.scroll]`: Automated scrolling animations. Uses a duration model with easing curve.
- `[role.caret]`: Text input cursor blinking. Uses a two-step periodic model.

Each role declares `reduced_motion` resolution (`instant`, `fade_instant`,
`opacity_only`, `direct`, or `steady_on`). When the operating system requests
reduced motion, the declared fallback replaces the standard animation model.

### ceilings.toml

`ceilings.toml` sets upper complexity limits evaluated during scene testing:

- Surface sections (`queue_card`, `queue_line`, `transcript_turn`, `block_chrome`, `composer`, `right_panel_chrome`, `terminal_drawer_chrome`): Sets maximum allowed distinct edge strokes, distinct gap spacings, distinct text sizes, and total interactive targets.
- `[ceilings.whole_window]`: Sets whole-frame aggregate maximums.
- `[ceilings.density_region]`: Defines the sample box dimension and the maximum allowable interactive targets per thousand square pixels.

Exceeding a declared count triggers a test failure during headless scene validation.

### Surface configuration files

The `tokens/surface/` directory contains component geometry and behavior settings:

- `shell.toml`: Minimum window width (800px) and height (560px), titlebar height (52px), control box sizes (28px), titlebar control spacing (`s4`), horizontal padding insets (`s6`), the background grain tile size and opacity, and the `[gate]` interaction strengths.
- `breakpoints.toml`: Threshold widths for `wide` (1440px), `standard` (1180px), `compact` (980px), and `collapsed` (800px). Sets queue presentation (`inline` or `overlay`), right panel presentation (`inline_540`, `inline_360`, or `overlay`), terminal drawer placement (`row` or `overlay`), drawer height, and button label visibility toggles.
- `queue.toml`: Width bounds for the sidebar, content insets, row heights for card and line styles, badge layout spacing, section gaps, footer dimensions, parked session pagination sizes, and the strengths a card's edge and title draw at when it is open, selected, at rest, or in flight.
- `transcript.toml`: Turn margins, message container widths, gutter dimensions, tool execution block styling, diff display options, and scroll bounds.
- `composer.toml`: Text input maximum width (768px), resting height (70px), maximum height expansion (200px), outer and inner radii, backdrop blur and shadow properties, run bar dimensions, opening line typography, and attachment thumbnail dimensions.
- `panels.toml`: Right panel and terminal drawer widths, minimum sizes, tab bar heights, tab item limits, and the monospace pane's overflow width, edge fade, scroll rail and thumb.
- `palette.toml`: Command palette and picker widths, maximum vertical bounds, row heights, search input typography, and result list limits.
- `attached-cards.toml`: Geometry, padding, corner radii, and badge limits for decision and approval cards.
- `settings.toml`: Settings page content width, row height (44px), typography steps, and input control spacings.

`[gate]` in `shell.toml` sets the strength a control draws at when it is visible and cannot be
activated:

- `pending_strength` (0.6): a capability request in flight. Activation is suppressed and no spinner
  appears under 400ms.
- `unavailable_strength` (0.4): a capability the host reported unavailable, with the reason readable
  at the control and no retry. The same value sets `ControlMetrics::disabled_opacity`, so a disabled
  primitive and an unavailable capability draw alike.

A capability the host has not answered for draws at full strength, identically to an available one.
Both values are ratios between 0 and 1; a value outside that range fails at startup.

### Theme files

`themes/dark.toml` and `themes/light.toml` declare color definitions:

- `[meta]`: Schema version (`version = 1`) and appearance name (`dark` or `light`).
- `[role]`: Base color roles specified as six-character hexadecimal strings (`#RRGGBB`). Defines grounds (`ground`, `rail`, `canvas`, `inset`, `float`), text inks (`foreground`, `secondary`, `muted`, `placeholder`), borders (`hairline`, `border`), and selection states.
- `[tint.<name>]`: Paired `fill` and `ink` definitions for semantic statuses: `working`, `done`, `failed`, `approval`, `input`, `plan`, `watching`.

Theme validation enforces contrast floors:

- Body text (`foreground`, `secondary`) must achieve at least 4.5:1 contrast against all five elevation ground colors.
- Micro text (`muted`, `placeholder`) must achieve at least 3.0:1 contrast against all five elevation ground colors.

A theme that falls below these contrast ratios is rejected on load.

## Hot reload

A background filesystem watcher monitors `crates/veyyon-desktop-tokens/tokens/`
and `themes/`.

When a file changes on disk:

1. The watcher coalesces writes across a 16 millisecond debounce window.
2. All twelve token files and the active theme are loaded and validated as an atomic set.
3. If validation passes, the new tokens are installed into the running window without restarting the process or interrupting active sessions.
4. The window redraws immediately using the updated metrics, colors, and fonts.
5. The active appearance mode (`dark` or `light`) remains preserved across reload.

## Validation and error handling

Validation failures are handled according to application lifecycle:

### Startup failures

At startup, `load_startup_bundle` parses all token files and bundled themes. If
any file is missing, contains invalid TOML syntax, declares unknown keys, exceeds
a section ceiling, references a missing scale step, or fails contrast checks,
the application prints the error with file path, line, and column to standard
error and exits with code 1.

### Hot reload failures

If a file edit creates an invalid state while the application runs:

1. The reload fails and the invalid tokens are discarded.
2. The running window retains the previously loaded valid token set.
3. A notification banner appears in the window displaying the error text, file path, line, and column.
4. The application continues running and accepting interaction.
5. Correcting the error in the file triggers another reload, installs the valid tokens, and removes the notification banner.
