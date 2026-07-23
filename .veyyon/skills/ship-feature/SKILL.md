---
name: ship-feature
description: Turn a merged Veyyon feature into a tracked, shippable change in one short pass, with its changelog, screenshots, and demo. Use right after a feature or fix lands, when preparing a release, or whenever someone asks why the repo is hard to track. Names the fixed release ritual and points at docs, screenshots, record-demo, and prove-feature for each step.
---

# Shipping a feature

A feature is not finished when the code compiles. It is finished when someone who was not in the room can see what changed, read why, and watch it work. The failure this skill kills: code lands, and the changelog, the screenshots, and the demo never follow, so the repo drifts into a state nobody can track.

The ritual is fixed so any agent runs it the same way, fast. The target from a merged feature to a tracked change is about five minutes, because every step below is a named command, not a research task. If a step takes longer, the tooling is the bug; fix the tooling, do not skip the step.

## The ritual

Run these in order. Each row says when it applies and which skill owns the detail. Do not reinvent a step's mechanics here; open its skill.

| Step | Applies when | Owned by |
| --- | --- | --- |
| 1. Changelog | Any user-facing change | [docs](../docs/SKILL.md) |
| 2. Docs sync | You changed a flag, command, setting, default, exit code, or behavior | [docs](../docs/SKILL.md) |
| 3. Settings differential | You added or changed a setting or a gated feature | [screenshots](../screenshots/SKILL.md) |
| 4. Demo | You changed a user-facing flow worth watching | [record-demo](../record-demo/SKILL.md) |
| 4b. Proof demo | The flow is a Veyyon differentiator (Argot, hashline, …) | [prove-feature](../prove-feature/SKILL.md) |
| 5. Gates | Always | below |

### 1. Changelog

Add a `## [Unreleased]` bullet to the changed package's `CHANGELOG.md` as the feature lands, in Veyyon's voice (second person, no hype, no em dashes). Then sync the repo-root file so GitHub's repo page carries it:

```console
$ bun run changelog:root
```

The [docs](../docs/SKILL.md) skill covers the register, the gate, and the root sync in full.

### 2. Docs sync

If you changed an observable surface, update every place that documents it in this same pass: the handbook page, the per-tool doc, the `--help` or command `description` text in code, and any SPEC. Grep the whole `docs/` tree and the help strings for the old wording, not just the page you remember. Rebuild the book and confirm the new wording landed. The [docs](../docs/SKILL.md) skill has the exact steps.

### 3. Settings differential

If the feature adds or changes a setting, capture the settings screen off and on, seeded from the shell with `config set`, so the pair proves the knob is wired. A gated feature that is off must hide its dependent knobs, and the off-vs-on pair is what proves that. The [screenshots](../screenshots/SKILL.md) skill owns the differential rule and the driver to copy.

### 4. Demo

If the change is a user-facing flow, record or refresh its demo. A demo submits a real prompt and ends on the finished result, driven by `scripts/demos/launch.sh` (work profile, Gemini 3.6 Flash with thinking high). The [record-demo](../record-demo/SKILL.md) skill owns the real-task rule, seeding, and the shared capture block. If the flow is a Veyyon differentiator, raise the bar with [prove-feature](../prove-feature/SKILL.md) so the gif shows something upstream cannot. Refresh any existing demo whose flow your change altered, or its gif now lies about the product.

### 5. Gates

Run the same gates CI runs, so nothing lands half-done:

```console
$ bun run changelog:check          # a bullet exists for the changed source
$ bun run changelog:root:check     # the root CHANGELOG matches the source
$ bun run check                    # types, lint, and the workspace checks
```

## Deciding what a change needs

Not every change needs all four artifacts. Decide by what the change touches, and do the ones that apply:

- Pure internal refactor, no observable effect: changelog may use a justified `[skip changelog]` marker; no screenshot, no demo.
- New or changed setting: changelog, docs, and a settings differential.
- New or changed user-facing flow: changelog, docs, and a demo.
- Veyyon-unique capability (Argot, hashline landing, compaction, …): changelog, docs, and a [prove-feature](../prove-feature/SKILL.md) demo, not a generic ask/edit toy.
- New flag, command, default, or exit code: changelog and docs; a demo only if the flow is worth watching.

When in doubt, produce the artifact. A missing proof is the exact drift this skill exists to prevent.

## How Veyyon ships

Veyyon is distributed two ways only: the `curl` installer from veyyon.dev, which fetches a signed binary that veyyon.dev serves and propagates automatically from GitHub Releases, and a `git clone` you build yourself. There is no npm package, no Homebrew tap, no `mise` plugin, and no crates.io release, and there never will be an npm one. Cutting a release publishes to GitHub Releases and redeploys the website; veyyon.dev then picks up the new binary. Installs and updates go through veyyon.dev; GitHub Releases is the upstream it mirrors. When you touch update or install code, that is the only version source, and any path that reaches for npm, Homebrew, `mise`, or crates.io is a defect to remove, not a channel to support. (User extensions are separate: a plugin may publish itself to npm; that is the plugin's business, not Veyyon's own distribution.)

## Done

The change is tracked and shippable when:

- The changed package has a `## [Unreleased]` bullet, and `bun run changelog:root:check` passes.
- Every observable thing you changed is documented with its new behavior, in every place that documents it, and the book rebuilds clean.
- Every setting or gated feature you touched has an off-vs-on differential whose frames genuinely differ.
- Every user-facing flow you changed has a current demo that shows real work finishing.
- `bun run check` is green.
