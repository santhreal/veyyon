---
name: screenshots
description: Capture and refresh Veyyon UI screenshots that prove a surface exists and works, not decorative stills. Use when a settings screen, tool renderer, or README image needs a new or updated shot, or when a feature needs its off-vs-on settings differential. Covers deterministic seeding, the differential rule, and the gallery screenshot path.
---

# Screenshots

A screenshot is evidence, not decoration. It proves a surface renders the way the docs claim. The two failures this skill kills are drift (the shot shows an old layout the code no longer draws) and a hollow shot (a picture that proves nothing because it was not seeded, or because its off-vs-on pair is identical).

Every screenshot regenerates from a command. None is hand-cropped or taken with a system screenshot tool. If you cannot name the command that reproduces a shot, it does not belong in the repo.

## The two kinds of shot

| Kind | What it shows | How it is made |
| --- | --- | --- |
| Settings differential | A feature off, then on, so the pair proves the knob is wired | A single-state tape recorded twice, seeded off then on with `config set` |
| Tool renderer gallery | A built-in tool's renderer across its states | `veyyon gallery --screenshot` |
| README still | A framed moment of the live TUI | A VHS `Screenshot` line in the demo tape, or a frame of the demo gif |

## The differential rule

A feature screenshot is a contrast, not a snapshot. This is the [10-minute proof rule](../../../AGENTS.md#proving-a-feature-the-10-minute-rule) in picture form: capture the settings screen with the feature off, then with it on, so the pair shows the toggle does something. An experimental feature that is off hides its dependent knobs, so the off shot has fewer rows than the on shot. That difference is the proof.

A degenerate pair is a failed proof. Two identical shots, or an "on" shot that is not actually on, prove nothing. Check that the bytes differ and the values changed before you commit the pair.

Seed each state from the shell, never from a keybinding:

```console
$ veyyon --profile work config set <path> off   # seed, then record the off shot
$ veyyon --profile work config set <path> on    # seed, then record the on shot
```

A TUI toggle can land on the wrong key and give you two identical or wrong frames. Seeding with `config set` before launch is the only reliable way to fix the state a frame captures.

`scripts/demos/record-argot-settings.sh` is the reference driver. It seeds `argot.enabled` off, records `assets/tapes/argot-settings.tape` to `assets/argot-settings-off.png`, seeds it on, records again to `assets/argot-settings-on.png`. The off shot shows only the master toggle; the on shot shows the toggle plus its four dependent knobs. Copy this driver for a new feature: one single-state tape, recorded twice, one shot per state.

## The gallery path

Tool renderers screenshot through the gallery, which renders every built-in tool across its streaming, in-progress, success, and failure states:

```console
$ veyyon gallery --screenshot                  # every tool, every state, to PNG
$ veyyon gallery --tool read --screenshot      # one tool
$ veyyon gallery --tool edit --state success --screenshot
```

VHS is a hard dependency of this path, and it fails loudly if VHS is missing rather than degrading to a lossy capture. The gallery pre-renders truecolor ANSI in a process where your theme and symbol preset are correct, then captures it through a real virtual terminal, so the pixels match what the live TUI draws.

## Determinism

Every shot must record the same each time.

- **Reset the fixture** before recording a workflow surface: `bash scripts/demos/reset-fixture.sh`. Settings and gallery shots make no model call, so they record fully offline; a workflow still needs the pristine fixture.
- **Seed state from the shell** with `config set`, per the differential rule above.
- **Pin the profile** (`--profile work`). Settings and gallery surfaces need no authenticated model, so any maintainer regenerates them offline. Override with `VEYYON_DEMO_PROFILE` to match launch.sh.

## Capture quality

Use the shared capture block from the [record-demo](../record-demo/SKILL.md) skill. It is the one place the black, sharp, crisp window settings live, so a still matches a gif. Do not fork a second capture block here: read it there and reuse it. A cramped, low-resolution shot reads as amateur next to a sharp, edge-to-edge black one, and pixel quality is a finding, not a detail.

## Wire the shot into what it documents

A new screenshot is only half the change. If the README or a handbook page embeds it, update that reference in the same edit, and confirm the alt text describes what the new shot shows. A shot in `assets/` that no page references is dead weight; either embed it or do not add it.

## Before you commit the shot

- It regenerates from a named command, recorded here as a tape header or a script.
- A feature shot is an off-vs-on differential whose two frames genuinely differ in bytes and in values.
- It was seeded from the shell with `config set`, not by pressing a toggle.
- It uses the shared capture block: pure black, sharp corners, crisp.
- Every page that embeds it points at the new shot, with alt text that matches it.
