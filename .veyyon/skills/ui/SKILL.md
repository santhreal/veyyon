---
name: ui
description: The mandatory ritual for any change that alters what the TUI renders. Every UI change is made on its own worktree and must ship a visible before/after proof, per theme and per ground, captured with VHS. Static change proves with a PNG pair; animation proves with a GIF pair. Use this before touching a component, layout, color, spacing, divider, status line, dialog, markdown/code renderer, or theme.
---

# Changing the UI

The UI regressed on `main` because visual changes landed with no visible proof.
A background fill that was invisible on one ground shipped as a black slab on
another; a divider read fine in the author's terminal and wrong in the user's.
The code compiled, the tests passed, and the screen still got worse. This skill
exists so that can no longer happen: a UI change is not the diff, it is the diff
**plus the picture of what it does**, and you cannot see that picture from the
terminal you edited in.

Two rules are binding, and a UI change that skips either does not land:

1. **Every UI change is made on its own worktree**, never on `main`.
2. **Every UI change ships a before/after visual proof**, captured with VHS,
   for each theme and each ground the change can affect. A static change proves
   with a PNG pair (before, after). An animation proves with a GIF pair.

Never judge a visual change from a `tmux` dump. `tmux` renders on its own black
ground, strips styling, and hides the entire class of fill, spacing, and
contrast bugs this skill is here to catch. The only evidence is a real VHS
render you look at, an exact-byte ANSI assertion in a test, or the user's own
screenshot.

## When this applies

Anything that changes rendered output: a component, a layout, spacing or
padding, a color or a fill, a divider or rule, the status line, a dialog or
overlay, the markdown or code-fence renderer, a spinner or transition, a symbol
preset, or a theme. If a reader could see the difference on screen, this ritual
applies. A pure logic change with no visible effect does not need it, but if you
are unsure whether a change is visible, treat it as visible and prove it.

## Step 1: Work in a worktree

Branch policy is `main`-only for everything else, but UI work is the standing
exception: it gets its own worktree and its own branch, so an in-progress visual
change never sits on `main` half-proven.

```console
$ git worktree add .worktrees/ui-<slug> -b ui/<slug>
$ cd .worktrees/ui-<slug>
```

`.worktrees/` is already gitignored, so the tree and the proof artifacts you
generate under it stay out of the index until you deliberately commit the source
change. When the change lands, remove the worktree:

```console
$ git worktree remove .worktrees/ui-<slug>
```

## Step 2: Capture BEFORE, from the base

The before shot is the surface as it renders **without your change**. Capture it
first, from the clean worktree base, before you edit anything.

Drive the exact surface with a VHS tape under `assets/tapes/`, or, for a
built-in tool renderer, with the gallery. Reuse the shared capture block and the
determinism rules from [record-demo](../record-demo/SKILL.md) and
[screenshots](../screenshots/SKILL.md); do not fork a second capture block here.

- A live surface (composer, dialog, status line, transcript): write or extend a
  tape that navigates to it, and end on a `Screenshot proof/<slug>/before-<theme>.png`.
- A tool renderer: `veyyon gallery --tool <name> --state <state> --screenshot --theme titanium --theme light --out proof/<slug>/before.png`.
  The repeatable `--theme` flag renders the whole theme set in one invocation and
  suffixes each file (`before-titanium.png`, `before-light.png`), so a tool
  renderer covers its matrix without seeding themes by hand. An unknown theme
  name fails the run rather than falling back to the active theme.

Seed every bit of state from the shell with `veyyon config set` before launch,
never from a keybinding, so the frame is deterministic and the after shot
differs only because of your change.

## Step 3: Make the change

Edit the component. Keep the change scoped to the surface you are proving.

## Step 4: Capture AFTER

Run the **same** tape or gallery command against your changed tree, writing to
`after-<theme>.png`. Same seed, same navigation, same dimensions: the only thing
that moved is your edit, so the pair isolates exactly what you changed.

A degenerate pair is a failed proof. If before and after are byte-identical, you
either captured the wrong surface or your change has no visible effect; find out
which before you continue. Look at both images side by side. The pair is the
proof, and you are the first reviewer of it.

## Step 5: The theme and ground matrix

One shot is not proof. The regressions this skill kills hid in the gap between
themes and grounds, so a UI proof is a **set** of pairs. At minimum, capture the
before/after pair in each of these, and any others the change plausibly touches:

| Theme | Ground | Why it is in the set |
| --- | --- | --- |
| `titanium` (default dark) | Black `#000000` | The brand's primary surface. |
| `light` (default light) | White `#FFFFFF` | The one sanctioned inversion; ember and silver must still hold. |
| `titanium` | Grey `#1e2127`-class | The user's real terminal is rarely pure black; a dark fill invisible on black shows as a slab here. |

veyyon picks dark vs light from the terminal background luminance (OSC 11), so
you force the theme by setting the terminal ground in the tape's `Set Theme`
background and pinning which named theme fills each slot:

```console
$ veyyon --profile work config set theme.dark titanium     # then record on a dark/grey ground
$ veyyon --profile work config set theme.light light        # then record on a white ground
```

In the tape, vary only the `Set Theme` background to move between grounds
(`"#000000"`, `"#1e2127"`, `"#FFFFFF"`); everything else stays on the shared
capture block. This is the one place the pure-black brand block is deliberately
set aside: a brand demo GIF keeps pure black, but a UI regression proof must
exercise the grounds a user actually runs, because that is where the bugs live.
`brand-conformance.test.ts` and [design.md](../../../docs/internal/design.md)
own the palette; this matrix proves your change respects it on every ground.

## Step 6: Animation proves with a GIF pair

If the change is animated (a spinner, a stream cadence, a transition, a
shimmer), a still cannot prove it. Capture a before/after **GIF** pair instead,
one per theme, with VHS `Output proof/<slug>/before-<theme>.gif` and a `Sleep`
long enough to hold the full motion. The same rules apply: same tape, same seed,
same dimensions, only your change moves. Watch both GIFs; a motion change that
looks identical frame to frame is either not wired or not visible, and either
way is a failed proof.

## Before you land

- The change was made on `.worktrees/ui-<slug>`, not on `main`.
- There is a before/after pair for every theme and ground in the matrix that the
  change can affect (PNG for static, GIF for animation).
- Every pair regenerates from a named command: the tape header or the gallery
  invocation is recorded next to the artifacts.
- You looked at every pair, and each one genuinely differs (bytes and pixels),
  in the direction you intended, with no regression on any ground.
- No pair was judged from `tmux`.
- The before/after pairs are attached to the PR so a reviewer sees the visible
  change without checking out the branch. If a shot also documents a shipped
  surface, commit it to `assets/` and wire it into the page that embeds it, per
  [screenshots](../screenshots/SKILL.md).
- If the surface has an exact-byte ANSI test, it is updated in the same change,
  so the render is locked in code as well as in pixels.
