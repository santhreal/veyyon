# Architecture

This is the desktop front end. It has to reach the surface count of a mature coding-agent client:
a transcript with a dozen block kinds, a composer with a dozen attached panels, a diff viewer, a
file browser, a terminal panel, a settings screen with tens of pages, a command palette, a model
picker, an approval flow, per-tool renderers for every tool the engine exposes. Hundreds of
surfaces, added over months, by more than one lane at a time.

Two front ends were read closely before this document. Both are further along than this one and both
show where the cost lands.

| | shape | what it costs |
|---|---|---|
| A Rust/gpui client | 12 crates, one 69k-line `ui` crate | `shell.rs` 8.4k lines, `transcript.rs` 7.6k, `composer.rs` 7.1k, `changes.rs` 5.6k. A surface is a region of a file, so two lanes in one surface collide, and a new block kind is an edit inside a 7k-line file. |
| A TypeScript/React client | 315 components under one app | Per-component `X.logic.ts` beside `X.tsx`, a 45-primitive `ui/` layer, one concern per file. Adding a surface adds files rather than growing them. Runtime cost sits elsewhere: it ships a browser. |

The discipline of the second, in a language with the first's performance, is the target. The rules
below are the mechanism, not the aspiration.

## The one rule

**A new feature adds files. It does not grow files.**

Everything else here exists to make that true. When a change to one surface forces an edit inside
another surface's file, the boundary is wrong, and the boundary is the defect to fix.

## Layers are crates

Cargo enforces the dependency direction. A layering rule written only in a document is a rule that
gets violated in the first hurry; a layering rule written as a crate graph fails the build.

```
veyyon-gui-core     no gpui, no toolkit, no I/O.  Data, moves, text analysis, registries.
        ^
veyyon-gui-kit      gpui only. Tokens and primitives. Never reads app state.
        ^
veyyon-gui-features core + kit. One directory per surface. Renderers and views.
        ^
veyyon-gui          the binary. Window, assets, keymap installation, frame clock, composition.
```

Arrows point at what a crate may depend on. There are no other edges, and there is never a reverse
edge.

- **core** compiles without a GPU, a display or a font. Its tests run in milliseconds. It holds the
  store, every move over the store, the command table, the keymap table, the settings declarations,
  and the text analysis (markdown, syntax, unified diff). A dependency on gpui here is a defect.
- **kit** holds colour, type, space, radius, elevation and motion tokens, and the primitives built
  from them: button, icon, row, card, sheet, menu, tooltip, field, badge, kbd, switch, stepper,
  meter, spinner, disclosure, separator, scrollbar, empty state. A primitive takes tokens, text,
  and callbacks. A primitive that names a store type, a session, a message or a setting is a defect.
- **features** holds one directory per surface and the content renderers. A surface reads the store
  and produces elements out of kit primitives. Two surfaces never import each other; they meet in
  the store and in the command table.
- **the binary** owns the window, the frame clock, the asset source, the menu bar, and the mapping
  from route to surface. It is the only place that knows the whole layout. It holds no feature logic.

Promotion path: a surface directory that outgrows the features crate becomes its own crate by adding
a `Cargo.toml` and one dependency line. Nothing inside it changes, because a surface already talks
only to core, kit and the command table.

## Registries, not central files

A central file that grows by one arm per feature is a merge conflict per lane and a 5k-line file
within a year. Five tables carry every cross-cutting concern instead, and each one is data.

1. **Commands** (`core::command`). `Command` is an enum with data. `Command::run(&mut Store) ->
   Outcome` is the only way anything changes. A command carries its title, its keywords, its group,
   and a predicate saying when it applies, so the palette, the menu bar and the settings screen all
   read one list.
2. **Keys** (`core::keys`). One table of chord, command, context and description. It feeds
   `cx.bind_keys` and the Keyboard settings page, so a binding cannot exist undocumented.
3. **Settings** (`core::settings`). Each setting is declared as data: id, group, label, description,
   kind (toggle, choice, number, text), default, and a predicate for when it is shown. The settings
   screen renders declarations. Adding a setting adds a declaration and a get/set arm, and no view
   code.
4. **Routes** (`core::route`). A route names a surface and carries its title and icon. The binary
   maps route to renderer in one match.
5. **Tool renderers** (`features::tools`). Keyed by the tool name the engine reports, with a default
   renderer for a name nothing claims. A new tool adds one file and one registration.

Every registry gets a sweep test that enumerates it at run time and fails when a member is added
without the thing that member needs. A hardcoded list of members in a test goes stale in silence,
which is the same as having no test.

## Everything goes through a command

The pointer, the keyboard and the palette dispatch the same `Command`. There is one gpui action,
`Do(Command)`; a click builds it with the argument it needs, a keybinding is bound to an instance of
it, and a palette row carries one.

```
click / keystroke / palette row
        -> Do(Command)
        -> Command::run(&mut Store) -> Outcome
        -> the shell performs the Outcome (focus a field, scroll, clear the composer, quit)
```

Three properties follow, and all three are why it is worth the indirection.

- A surface needs no handle on the view type. It is a function of the store and the theme, and it
  can be moved between crates without rewriting its listeners.
- Every action is reachable by pointer, by key and by search, by construction. A feature cannot ship
  keyboard-only or mouse-only by accident.
- Behavior is tested without a window. `Command::run` is a pure function over the store.

`Outcome` is a small enum of effects the store cannot perform on itself. It stays small on purpose:
a new variant is a claim that a feature needs a new kind of window effect, and that claim should be
argued.

## Surface anatomy

```
features/src/<surface>/
    mod.rs      what the surface is, and its public entry point: render(&mut Frame) -> Div
    view.rs     the elements. kit primitives only, no colour literals, no ad-hoc sizes.
    logic.rs    the pure decisions: what is visible, what is grouped, what is ordered, what is
                elided. No gpui types. Tested directly.
    tests.rs    the suite for logic.rs, and the windowed suite when the surface has one.
```

A surface receives a `Frame`: the store, the motion registry, the theme, this frame's instant, and
the entity handles it needs. It returns elements. It never reaches for the clock, never reads a
global other than the theme, and never mutates the store outside a command.

Recipe for a new surface, in full:

1. `core`: add the state it reads, the moves it needs, its commands, its keys, its settings.
2. `core::route`: add a route variant if it is a destination rather than a panel.
3. `features/src/<surface>/`: four files as above.
4. `app`: one match arm mapping the route to the entry point.
5. Tests: the logic suite, the registry sweeps that now cover the new members, and a windowed suite
   if it takes keystrokes.

No other file changes. If a step 6 appears, the layering is wrong.

## Rules with teeth

These are checked, not trusted.

- **File ceiling: 400 lines.** A table-only file (icons, keys, palettes) may reach 700. Over the
  ceiling, split by concern. `scripts/the-gui-workspace-is-outside-the-rust-gates.test.ts` fails the
  repo gate on a file over the ceiling and on a crate dependency edge that is not in the graph
  above.
- **One concern per file, and the file is named for the concern.** `send.rs`, not `helpers.rs`.
- **No colour, size, radius or duration literal outside the token modules.** A literal in a surface
  is a token that has not been named yet.
- **Concrete element return types.** `-> Div`, `-> Stateful<Div>`, `-> AnyElement`. Never
  `-> impl IntoElement`: under edition 2024 an RPIT captures every input lifetime, and the borrow
  outlives the frame.
- **No `unwrap`, `expect`, `panic!` or slicing that can go out of bounds in non-test code.** A front
  end that aborts on a malformed message is worse than one that draws it plainly.
- **Time is an input.** The store holds `now_ms`; moves take it. Nothing below the binary reads the
  clock.
- **Motion is a registry keyed by element, not a per-element animation object.** A value is read
  during render and advanced once per frame. A frame is requested only when something is moving.
- **Class privacy is `#private`'s Rust equivalent: no `pub` on a field a caller does not read.**

## State

The store is plain data with plain functions over it. It has no methods that draw, no handles into
the toolkit, and no interior mutability.

- A field with no producer does not exist. A surface that would need a fabricated value to draw is
  not built until the value has a source. This is why the transcript has no reply in it while no
  engine is attached: the honest window is the requirement, and a fixture in the store is a lie that
  every later feature is built on top of.
- Engine-facing shapes are defined before the engine exists, because wiring is then a matter of
  filling them. Defining `ToolCall` costs nothing and is not a fixture; constructing one with
  invented contents in the shipped path is.
- A move returns whether it changed anything, so the frame after a no-op move is not drawn.

## Text and content

Message content is parsed, not printed. Three parsers in core, each total over arbitrary input and
each tested against adversarial input:

- `text::markdown` produces blocks and inline spans.
- `text::syntax` produces colour spans for a fenced body, per language, with strings and comments
  dominating keywords.
- `text::diff` produces files, hunks and numbered lines from a unified patch.

Rendering is separate from parsing, in `features::render`, one file per block kind. A new block kind
adds a file and a registration, and no existing renderer changes.

## Theme

One token owner per axis: colour, type, space, radius, elevation, motion. Two palettes, one field
set, checked by a suite that fails when a boundary between two fills falls under the visible floor.

A terminal theme file describes sixteen ANSI colours and says nothing about a sidebar, so it is not
the source for chrome. It supplies the transcript's syntax colours, which is the one thing it
describes. There is one theme format, and it is this one.

## Testing

| layer | how it is proved |
|---|---|
| core | direct unit and property suites. No window, no display. Adversarial input for every parser. |
| kit | headless gpui suites for measurement and interaction; token suites for contrast and depth order. |
| features | logic suites for every decision; windowed suites for keyboard reachability and focus. |
| binary | one windowed smoke suite that opens the window, walks every route, and asserts the keyboard reaches each one. |

Every suite opens with `//! WHY THIS SUITE EXISTS.` and closes the header with
`//! WHAT IT DOES NOT CATCH.` Test names are prose sentences naming the behavior they defend. A test
that reads source text and asserts on it is not a test.

Visual proof is a capture pair from the harness, off and on, at the widths where the layout changes
what it drops. A frame at defaults proves nothing about a knob.

## Forbidden

- A god module. Anything over the ceiling is split before the next feature lands in it.
- A second theme format, a second token owner, a second colour literal site.
- A fixture, a mock, a placeholder or a fabricated value in the shipped path.
- A reverse dependency edge, a surface importing a surface, a primitive importing state.
- `impl IntoElement` in a signature, an `unwrap` in a draw path, a clock read below the binary.
- A keyboard-only or pointer-only action. Both reach the same command, or the command is incomplete.
