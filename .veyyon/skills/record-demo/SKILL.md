---
name: record-demo
description: Produce a Veyyon demo GIF or screenshot that shows a REAL task completed, not static typing. Use when adding or fixing any demo in assets/tapes, or when a feature needs its proof demo. Covers the real-use-case rule, deterministic seeding, and the brand-sharp capture settings.
---

# Recording a Demo

A demo earns its place by showing Veyyon **finish a real task**. The failure this skill exists to kill: a tape that boots, types a prompt, and stops. Typing is not a demo. The old `hero.tape` typed "add rate limiting to the upload endpoint" and ended before the agent did anything, so it showed nothing a reader could not have imagined. Competitors show the agent read, edit, run, and report. Match that or do not ship the demo.

## The one rule

**Submit, then show the outcome.** Every workflow demo must:

1. Type the prompt AND press `Enter` to submit it.
2. Let the agent actually work: read files, call tools, stream its answer, apply an edit.
3. End on the finished result the user came to see: the diff, a passing test, the rendered output, the answer. Not the spinner, not the typed prompt.

If the outcome takes N seconds, `Sleep` for N plus a margin so the last frame is the result. A demo that cuts off mid-stream is the same failure in a new costume.

## Determinism

A demo must record the same every time or it is not reproducible.

- **Reset the fixture** before every recording: `bash scripts/demos/reset-fixture.sh`. `record.sh` already does this per tape. Editing demos mutate `~/orbit/src`; the reset restores it from a pristine copy so frame N is always identical.
- **Seed state from the shell, never from a keybinding.** To show a setting on/off, set it with `veyyon --profile work config set <path> <value>` BEFORE launch, not by pressing a toggle in the TUI. TUI toggles land on the wrong key and produce identical or wrong frames. See `scripts/demos/record-argot-settings.sh` for the pattern: seed off, record, seed on, record.
- **Demo under the `work` profile with Gemini 3.6 Flash pinned high.** `scripts/demos/launch.sh` uses `--profile work`, `--model google-antigravity/gemini-3.6-flash`, and `--thinking high` so the wire id is `gemini-3.6-flash-high` (without thinking, collapse defaults to `-low`). `record.sh` preflights the pin and refuses to record on resolve failure — no silent 3.5 fallback. If resolve says not found: `veyyon --profile work models refresh`. Override via `VEYYON_DEMO_MODEL` / `VEYYON_DEMO_THINKING` / `VEYYON_DEMO_PROFILE` only, and say why in the tape header.
- Settings navigation makes no model call, so settings demos record fully offline. A workflow demo needs the demo profile authenticated with antigravity; a maintainer runs it, CI does not.

## The capture block

Pixel quality is a finding, not a detail. A cramped, low-resolution 1200x620 GIF reads as amateur next to a large, sharp, edge-to-edge black one. The frame is austere on purpose: pure black, sharp corners, no colorful window chrome. That is the brand, not an accident, and it matches the Canvas rule (a surface that owns the viewport paints black edge to edge). Start every tape with this block (all keys verified against the pinned VHS):

```tape
Set Shell bash
Set FontSize 22
Set Width 1400
Set Height 800
Set Padding 30
Set Margin 40
Set MarginFill "#000000"
Set BorderRadius 0
Set Framerate 30
Set TypingSpeed 55ms
Set CursorBlink false
Set Theme { "name": "veyyon", "black": "#000000", "background": "#000000", "foreground": "#C6CBD4", "cursor": "#F0862E" }
```

Why each matters: larger `FontSize` + `Width`/`Height` render crisper (there is no DPI knob, dimensions are the resolution); `Margin 40` + `MarginFill "#000000"` give a black bezel so the terminal is not jammed to the GIF edge, and pure black keeps that bezel on brand rather than the old blue-tinted `#0b0b12`; `BorderRadius 0` keeps the corners sharp, with no rounded frame and no colorful window bar, so the recording reads as veyyon and not a generic mac window; `Framerate 30` keeps motion smooth; `CursorBlink false` stops a distracting blink in stills and screenshots. Keep the veyyon theme; do not swap it.

## Feature and settings demos: prove a differential

A feature demo is a CONTRAST, not a snapshot. Follow the proof rule in `AGENTS.md` ("Proving a Feature"): capture the feature off and the feature on, seeded via `config set`, so the pair shows the knob does something. An experimental feature that is off hides its dependent knobs, so the off shot has fewer rows than the on shot. A degenerate pair (two identical shots, or the "on" shot not actually on) is a failed proof: check the bytes differ and the values changed. `scripts/demos/record-argot-settings.sh` is the reference driver.

For a screenshot at an exact moment, use `Screenshot assets/<name>.png` mid-tape. Screenshots record offline for any settings surface.

## Recording

```console
$ bash scripts/demos/record.sh                 # every tape in assets/tapes
$ bash scripts/demos/record.sh hero edit       # only the named tapes
$ bash scripts/demos/record-argot-settings.sh  # the argot off-vs-on differential
```

Outputs land in `assets/` (`assets/demo-<name>.gif`, screenshots beside them). Tapes live in `assets/tapes/*.tape`; shared launch config is `scripts/demos/launch.sh`. For a demo that must prove a Veyyon-unique capability (not a generic coding-agent task), follow [prove-feature](../prove-feature/SKILL.md) before you commit the tape.

## Before you commit the demo

- It submits a prompt and ends on the finished result, not the typed prompt or a spinner.
- It shows real work: a tool call, an edit/diff, an actual answer.
- It reproduces: fixture reset, state seeded from the shell, model pinned.
- It uses the shared capture block: pure black, sharp corners, crisp.
- A feature/settings demo is an off-vs-on differential whose frames genuinely differ.
- The tape has a header comment saying what it shows and the exact command to regenerate it.
