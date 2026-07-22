---
name: prove-feature
description: Design and record a demo that proves a Veyyon-unique capability end to end, not a generic coding-agent toy task. Use when positioning Veyyon against upstream, when POS-style demo work is open, or when a feature needs a showcase that only this fork can show (Argot, hashline landing, compaction, cockpit, and similar).
---

# Proving a feature

A shipped demo that any coding agent could have recorded is wasted space. This skill is the bar above [record-demo](../record-demo/SKILL.md): the capture must show something Veyyon uniquely does, finished, on screen.

Use record-demo for mechanics (pin, capture block, Enter, Sleep, fixture reset). Use this skill to decide *what* to film and whether the tape is allowed to ship.

## The bar

The last frame must answer: “Why not just use upstream / a generic agent?” If removing the Veyyon-specific mechanism would leave the same gif, scrap the tape.

| Worth proving | Not worth proving alone |
| --- | --- |
| Argot off vs on (handles expand, shorter wire) | “What does this file do?” on a toy fixture |
| Hashline edit that lands with visible anchors/diff | Typing `/model` and stopping |
| Plan mode that writes a plan and holds mutation | Mid-grep cutoffs |
| Compaction / snap that visibly shrinks context | Splash + idle composer |
| Cockpit / multi-agent inbox during real concurrent work | Fake HTML terminal copy |

Generic ask/edit/hero tapes may still exist as orientation, but a *proof* demo for a differentiator follows this skill.

## Design the tape

1. **Name the unique mechanism** in the tape header (one sentence).
2. **Show a contrast when the feature is gated.** Off then on, seeded with `config set`, same as screenshots. Degenerate pairs fail.
3. **End on the outcome:** expanded handle, landed hashline diff, written plan file, compacted transcript, live inbox. Not the spinner.
4. **Keep the fixture honest.** Prefer a small real shape that forces the mechanism (repeated long strings for Argot, multi-hunk edit for hashline). Do not rely on `~/orbit`’s two toy files if they cannot surface the win.
5. **Reuse launch defaults.** `scripts/demos/launch.sh` (work profile, Gemini 3.6 Flash high). No second pin.

## Record and embed

```console
$ bash scripts/demos/record.sh <name>
# or a dedicated driver, same pattern as:
$ bash scripts/demos/record-argot-settings.sh
```

Then wire the artifact into README and/or the website in the same change. An untracked gif or a capture no page embeds is not a proof. Replace hand-coded fake terminals when a real capture exists.

## Before you commit

- The mechanism named in the header is visible in the final frames.
- record-demo’s one rule holds: submit, real work, end on the result.
- Off/on proofs differ in bytes and in values.
- README or site embeds the artifact with accurate alt text.
- You viewed the rendered gif, not only the tape source.
