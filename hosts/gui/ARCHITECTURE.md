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
within a year. Tables carry every cross-cutting concern instead, and each one is data.

Built:

1. **Commands** (`core::command`). `Command` is an enum with data. `Command::run(&mut Store) ->
   Outcome` is the only way anything changes. A command carries its title, its keywords, its group,
   and a predicate saying when it applies, so the palette, the menu bar and the settings screen all
   read one list. `applies` and `run` are exhaustive matches in `core::command::run`, so a new
   variant does not compile until both are answered.
2. **Keys** (`core::keys`). One table of chord, command, context and description. It feeds
   `cx.bind_keys` and the Keyboard settings page, so a binding cannot exist undocumented. A second
   table in `kit::input::keys` binds the caret, in its own contexts, for the same reason.
3. **Icons** (`kit::ui::Icon`). One enum, one glyph each, and `features::glyph` maps a command to
   one where a drawing carries meaning. Most commands map to nothing on purpose.
4. **Motion channels** (`kit::motion::Channel`). Every number that moves is addressed by one, and
   the registry advances all of them once per frame.
5. **Settings pages** (`core::store::model::SettingsPage::ALL`). The nav is built from the list and
   swept by a suite, so a page cannot ship unreachable.
6. **Palette entries** (`core::command::searchable` plus the store's conversations). One list, in
   the order the palette draws it.

Not built yet, and named here so neither is invented twice:

- **Per-setting declarations.** Settings are model fields with moves over them, and the settings
  view names each one. A declaration table (id, group, kind, default, visibility predicate) is what
  turns tens of pages into data, and it is worth writing when the engine's settings arrive, because
  those are the ones that need a predicate.
- **Tool renderers.** `features::render::tool` draws one shape. Keying renderers by the tool name
  the engine reports needs an engine reporting names.

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

`Outcome` is a struct of the effects the store cannot perform on itself: where the caret goes,
whether the field takes the store's draft again, whether the transcript moves, whether the window
closes. A struct rather than an enum because a send does two of those at once, and an enum would
force one of the two to be implicit. Every field is a claim about the window, and a new one has to
be argued for.

One command backs out of one thing at a time. `Command::Back` closes the palette if it is open,
else the settings page, else nothing, because two Escape rows in one keymap context means one of
them never fires.

## Surface anatomy

```
features/src/<surface>/
    mod.rs      what the surface is, and its entry point
    view.rs     the elements. kit primitives only, no colour literals, no ad-hoc sizes.
    logic.rs    the decisions: what is visible, what is grouped, what is ordered, what is
                elided. No gpui types. Tested directly.
    tests.rs    the suite for logic.rs.
```

A surface with no decisions has no `logic.rs`. A surface never holds a view handle: it is a
function of `(&Store, …, &mut App)` returning elements, and the state that must outlive a frame is
passed in (the two `Editor` entities, the two `ScrollHandle`s). Interaction leaves through
`features::act::Do(Command)`, so a surface has nothing to subscribe to and nothing to notify.

Two globals are readable during a frame, both in `kit`: the theme, and `kit::paint`, which holds
the motion registry and this frame's instant. Nothing below `app` reads a clock; `paint::begin`
stamps the instant once per frame and `paint::end` advances every channel.

Recipe for a new surface, in full:

1. `core`: add the state it reads, the moves it needs, its commands, its keys, its settings.
2. `core::store::model::Route`: add a variant if it is a destination rather than a panel.
3. `features/src/<surface>/`: the files above.
4. `app`: one match arm mapping the route to the entry point.
5. Tests: the logic suite, the registry sweeps that now cover the new members, and a row in the
   app's windowed suite if it takes keystrokes.

No other file changes. If a step 6 appears, the layering is wrong.

## The window

`app` is three files and holds no feature logic.

- `main.rs` opens the window, installs both key tables, and builds the menu bar from `Command`.
- `shell.rs` holds the store, the two fields, the two scroll handles, and the one action listener.
  `Shell::perform` runs a command and carries out its `Outcome`; `Shell::settle_focus` is the only
  place focus is decided, because a binding dispatches along the focused element's ancestors and a
  route change can unmount the focused field.
- `chrome.rs` draws the frame: two headers, the window controls, the drag surface and the resize
  edges. Two headers rather than one titlebar, so the chrome colour stops at the sidebar's edge and
  the content column keeps its top corner.

## Rules with teeth

These are checked, not trusted.

- **File ceiling: 400 lines**, tests included.
  `scripts/the-gui-crates-only-depend-downward.test.ts` walks every source file and fails the repo
  gate on one over the ceiling, on a crate dependency edge that is not in the graph above, and on a
  member with no declared position in it. A file that needs more than 400 lines to hold one concern
  is two concerns; the exemption table in that test is empty, and an entry in it is a decision.
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
- **An overlay is the root of what its surface returns.** An absolutely positioned element is laid
  out against its own parent, not against the nearest ancestor that asked to be positioned, so a
  wrapper around a sheet is a box the sheet then fills. Wrapped in a flex item of no height, the
  command palette took the keyboard and drew nothing. `a_press_beside_the_palette_lands_on_its_ground`
  presses the corner of the window and fails when the ground is not under it.
- **Words shrink; controls do not.** A row that puts a label beside a control gives the label
  `flex_1` and a minimum of zero, and the control `flex_none`. A flex item's automatic minimum is
  its own content, so a note without that floor keeps the row wider than the card it sits in and
  pushes the control out through the edge of the window. The floor is stated on the call after
  `flex_1()`, as `min_w(px(0.0))` in a row, `min_h(px(0.0))` in a column, or `overflow_hidden()`
  where the content is clipped anyway, and
  `scripts/the-gui-crates-only-depend-downward.test.ts` fails on a `flex_1()` with none of the
  three beside it. Checking it costs a walk of the source because the defect is invisible until a
  window is narrow enough or a string long enough: a URL in a list item, a path in a diff header, a
  fence inside a quote. Every such row is also checked at the narrowest width the window opens at,
  not only at the width it was drawn for.
- **A primitive owns the motion channel it drives.** A caller that wants to fade with a row's hover
  asks the row (`Row::hovered_child`) rather than reading the channel itself: a key derived by hand
  agrees until one side renames it, and then a control silently stops appearing.
- **The window fits the display it opens on.** A fixed size centred on a smaller display hangs off
  every edge, and what leaves through the bottom one is the composer.
  `the_window_opens_inside_the_display` sweeps display sizes across both rules.
- **A control that does nothing draws nothing.** A primitive given no listener drops its cursor, its
  hover wash and the mark that says it can be pressed: a `Disclosure` with no `on_toggle` is a
  label, and a tool row whose call produced no output has no chevron. What it keeps is the chevron's
  track, so a column of headers with and without bodies still reads as one column.
- **A list the keyboard walks is tracked, and its selection is put back in view by the command that
  moved it.** The box that scrolls takes a `ScrollHandle`, the surface says where the selected row
  sits among that box's children (`palette::selected_child`, `sidebar::selected_child`), and
  `Outcome::reveal_selection` is what asks the window to scroll. Not during render: a list put back
  on its selection every frame fights the wheel, and the reader watches it drag itself back.
  `only_a_command_that_moves_a_selection_asks_for_it_to_be_revealed` pins the set of commands that
  ask, so a new one that moves a selection turns red until it is decided. A heading is a child of
  the box like a row is, which is why the count is a function and not the row's own index.
- **Every box that scrolls draws a bar.** gpui's `overflow_y_scroll` scrolls and draws nothing, so a
  region without a [`Scrollbar`] gives no sign that there is more of it. The bar is a sibling of the
  scrolling box inside a `relative()` wrapper, because it measures its thumb against its own parent:
  hung one level out, it draws the thumb from the top of whatever header is above the list.

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
- A fold the reader can change is stored as an answer beside the default rather than recomputed:
  `ToolCall::open` is `Option<bool>`, `None` follows the state, and `unfolded()` is the one place
  the two are combined. Recomputing it from the state on every update folds a row the reader opened
  the moment the call finishes, which reads as the window undoing a press. `store::tests::folding`
  sweeps every `ToolState` for both the default and the survival of the answer.

## The seam an engine writes an answer through

Four moves in `store::moves` are the whole store side of an arriving answer. A transport calls these
and nothing else, and every one is addressed by conversation:

| move | what it does | returns |
|---|---|---|
| `begin_answer(store, id, now_ms)` | opens an empty answered message and records it in `session.answering` | its message id, or `None` when that conversation already has one open |
| `extend_answer(store, id, delta, now_ms)` | appends a delta and reparses | whether anything changed |
| `finish_answer(store, id)` | closes the answer, dropping an empty one | whether an answer was open |
| `fail_answer(store, id, why)` | closes it and raises a notice | whether an answer was open |

- **A conversation is the address, never the selection.** An answer arrives for the conversation it
  was asked in. Reading a different one while it arrives is the ordinary case, so no move here reads
  the selection.
- **A delta reparses the whole answer.** A delta arrives inside a fence that has not closed, so
  appending parsed blocks would freeze the reading of a half-written construct. `Answer` holds the
  raw text for that, and for nothing else.
- **One answer per conversation.** A second `begin_answer` is refused rather than replacing the
  first, because two writers on one message is a transport defect and the store is where it shows.
- **An answer that closes with nothing in it leaves nothing behind.** A failed request is a notice,
  not an empty reply.

Nothing calls these yet, and nothing invents a reply.

## Text and content

Message content is parsed, not printed, once at write time rather than per frame. Three parsers in
core, each total over arbitrary input, each split one file per language or per concern, and each
tested against adversarial input:

- `text::markdown` produces blocks and inline spans. Every construct has a reading while it is
  still half-written, because a message arrives a token at a time.
- `text::syntax` produces colour spans for a fenced body, one scanner per language, with strings and
  comments dominating keywords and an unterminated one running to the end.
- `text::diff` produces files, hunks and numbered lines from a unified patch, and answers whether a
  fence with no info string looks like one.

Rendering is separate from parsing, in `features::render`, one file per block kind. A new block kind
adds a file and a registration, and no existing renderer changes. A block is drawn as styled runs
over one text element rather than one element per span.

Which ground a block is drawn on is decided per block rather than per message. Prose sits in a
bubble that hugs it. A block with a ground of its own, which is a fence, a table, a patch or a tool
call, is drawn beside the bubble at the side's own width, because a fill around a card is two fills
around one thing. A quote is classified by its contents, since a quote of a fence draws that fence's
well. `render::message::alone` names every block kind, so a new kind stops the build until the
decision is recorded.

## Theme

One token owner per axis: colour, type, space, radius, elevation, motion. Two palettes, one field
set.

A ground carries two things, and the suite holds it to both. The hairline says where a surface
ends; the fill says which layer it is, at 13/255 or more against the ground under it, in both
appearances and within a factor of two of each other. A palette whose canvas sits at the top of its
range has nothing left for a surface to lift into, which is a window of crisp outlines on one flat
sheet: the light canvas is a grey, a card is white, and the chrome recedes below both.

A terminal theme file describes sixteen ANSI colours and says nothing about a sidebar, so it is not
the source for chrome. It supplies the transcript's syntax colours, which is the one thing it
describes. There is one theme format, and it is this one.

Text is drawn grayscale, asked for once at startup. Subpixel rendering is what Linux and Windows
pick and what macOS dropped, and it puts a blue fringe down the left of every stem and an orange one
down the right: a captured glyph edge carried 140 parts in 255 of colour on text that is one grey.
One mode means one window on three platforms.

## Optical alignment

Three rules, each written after a capture showed the defect it prevents.

- **A ground changes where its column ends.** The strip between two columns is five points wide so
  it can be grabbed, and it carries the ground of the side it is not part of: `chrome::handle` is
  painted with the canvas. Inherited from the sidebar instead, it puts five points of chrome past
  the sidebar's own width, and every row in the list reads five points left of centre against the
  edge a reader sees.
- **A control centres on its ink, not on its box.** A keycap centres its line box, which is right
  for a letter, a digit or a word and wrong for punctuation: a comma's ink is entirely below the
  baseline and lands on the key's floor. `ui::kbd::ink_offset` corrects the characters that are off
  centre and its suite pins the set. A labelled button's icon box is the glyph's size rather than
  the button's height, so its glyph lands where a list row's glyph does one column over.
- **The lines around a field align with the field's text.** The notice above the composer and the
  hint below it are inset by the pill's border, its padding and the field's own inset, not by the
  pill's outer edge.
- **A card's caption band and the room under its content are one measurement.** A fence and a patch
  wear the same compact band, and nothing pads the block above it, so the room up there is what
  centring a line box in that band leaves. The padding under the last line matches it; a full step
  there reads as 13 against 8 and tips the block upwards.
- **A marker ends where its column ends.** Centred in its column, a bullet sits in from the prose
  edge and an ordered list starts and ends in four places down its own length. Ending the marker at
  the column's edge is one gap to its words and one line for the periods.
- **A list has one gap, list to list.** `space::ROWS` is that gap, and it exists to keep two hover
  fills from touching. A disclosure's body had none, so a folded checkout drew its rows touching
  while an unfolded one did not.

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
- A control drawn faint and left on the page because the setting it depends on is off. A dependent
  control is gone, not greyed, so no primitive carries a disabled face. A button at the end of a
  range is what the stepper needs, and a range is not a dependency.
- A chevron, a pointer cursor or a hover wash on something that cannot be pressed. The affordance is
  the claim; a press that does nothing is the window contradicting it.
