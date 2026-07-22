---
name: docs
description: Write and fix Veyyon user-facing docs to the project quality bar, and keep them in sync with code. Use when editing the handbook, tool docs, README, --help text, SPEC, or CHANGELOG, or when a code change touches an observable surface (a flag, command, setting, default, exit code, or behavior).
---

# Docs

Docs are held to the same bar as code. A stale doc is a bug: it tells the reader the tool does something it no longer does. The two failures this skill kills are drift (code changed, docs did not) and low quality (a dense, hype-y, term-before-definition wall that a new reader cannot follow).

## Where docs live

| Surface | Location |
| --- | --- |
| Handbook (the book) | `docs/handbook/src/**.md`, built to `docs/handbook/book/` with `mdbook` |
| Per-tool reference | `docs/tools/<tool>.md` |
| Slash-command reference | `docs/handbook/src/reference/slash-commands.md` |
| Command / flag help | the `description` fields in code (`builtin-registry.ts`, `cli/flag-tables.ts`, tool defs) |
| Changelog | `packages/<pkg>/CHANGELOG.md`, under `## [Unreleased]` |
| SPEC | the package's SPEC where one exists |

The `src/**.md` files are the source of truth. `docs/handbook/book/` is generated: never hand-edit it.

## Register: the Rust Book voice

Write like the Rust Book. This is binding for every user-facing doc.

- **Second person, calm, instructional.** "You set `session.workdir` to..." not "One may configure...".
- **Example first.** Show the concrete command or config, THEN explain it. A reader copies the example and reads the prose only if it breaks.
- **Define every term before you use it.** No forward references to a concept the reader has not met.
- **Short declarative sentences.** One idea each.
- **No hype, no marketing.** No "blazing", "powerful", "seamless", "legendary". State what it does.
- **No em dashes. Ever.** Rewrite with a comma, a colon, parentheses, or two sentences. This holds in every doc and every changelog line.

Capabilities belong in the README/SPEC, not scattered into every page. In code, one line of comment is almost always enough.

## Sync: docs change in the SAME edit as the code

When you change a flag, subcommand, slash command, setting, default value, config path, exit code, env var, or any observable behavior, you update every place that documents it in the same change, never a deferred follow-up:

- the handbook page and the per-tool `docs/tools/<x>.md`,
- the `--help` / command `description` text in code,
- any SPEC or changelog that mentions it.

A change is not complete until the docs describe the NEW behavior. Grep the whole `docs/` tree plus `--help` strings for the old name or old wording, not just the page you remember.

## The changelog gate

Shipped-source changes must carry a `## [Unreleased]` changelog bullet as they land. The gate is mechanical:

```console
$ bun scripts/require-changelog.ts        # or: bun run changelog:check
```

It fails when a publishable package changed shipped source (not tests/docs/metadata) but its `## [Unreleased]` gained no bullet, and it names the exact `CHANGELOG.md` to edit. A change with genuinely no user-facing effect opts out with a `[skip changelog]` marker in a commit message (or `[skip changelog: <package>]` for one package), so the decision lives in git history, never silently. Add the bullet; do not reach for the skip marker to dodge a real user-facing change.

The changelog GitHub shows on the repo page is the repo-root `CHANGELOG.md`. It is generated from `packages/coding-agent/CHANGELOG.md`, never hand-edited: it keeps veyyon's own entries, rebrands them into Veyyon's voice, and credits pre-fork oh-my-pi history in one note, the same render the website uses. Regenerate it after any source-changelog edit, and a second gate checks it:

```console
$ bun run changelog:root         # write the root CHANGELOG.md from the source
$ bun run changelog:root:check   # fails if the root drifted from the source
```

If `changelog:root:check` fails, run `changelog:root` and commit the result. Do not edit the root file by hand: your edit is overwritten on the next sync.

## Rebuild and verify

After editing any handbook `src/**.md`, rebuild the book and confirm your wording landed:

```console
$ cd docs/handbook && mdbook build
$ grep -r "your new wording" docs/handbook/book/ | head
```

Then run the gates the same way code is gated: `bun run changelog:check`, `bun run changelog:root:check`, and the doc-example/coherence tests (`bun test packages/coding-agent/test/docs-examples.test.ts`).

## Before you commit the docs

- Every observable thing you changed in code is described with its NEW behavior, in every place that documents it.
- A `## [Unreleased]` bullet exists (or a justified `[skip changelog]` marker), and `bun run changelog:root:check` passes.
- The page reads example-first, second person, terms defined before use, no em dashes, no hype.
- The book rebuilds clean and the new wording is in the generated HTML.
- You grepped for the OLD wording repo-wide and left none behind.
