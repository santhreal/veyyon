# Contributing to Veyyon

Thanks for your interest in contributing. Issues and pull requests are open to
everyone; please read this before opening a PR.

## TL;DR

- **Issues are open to everyone.** File bugs, feature requests, and questions
  freely — they are triaged automatically.
- **Pull requests are open to everyone too.** Open a PR against `main`. It runs
  through CI and an automated review, then a maintainer reviews it.

## Opening a PR

1. Fork the repo (or branch, if you have write access) and make your change.
2. Put a changelog entry under the affected package's `## [Unreleased]`
   section, keep the PR description short (what broke, the fix), and make sure
   `bun run check` and the tests pass locally.
3. Open the PR against `main`.

## UI changes

If your change affects anything visible (the TUI, the onboarding flow, the
website, a rendered output), include a **before and after screenshot** in the PR
description. Put the current `main` behavior first, then your change, so a
reviewer can see the difference without checking out the branch. A short GIF is
fine when the change is about motion (a splash, a transition, a live update).
Text-only and internal changes do not need one.

## What happens to your PR

Every PR runs the full CI suite before a human looks at it:

| Stage | What it does |
| --- | --- |
| **Checks** (`checks.yml`) | Biome lint + type check, TypeScript workspace tests |
| **CI** (`ci.yml`) | Native addon builds, Rust + TS test matrix, install-method smoke tests |
| **Site** (`site.yml`) | Builds the website when a PR touches `website/**`, so a blog post or report with bad frontmatter fails here; deploys on merge to `main` |
| **Devin review** | A maintainer requests an AI review by commenting `/devin review` on the PR |
| **veybot** | The in-repo review bot posts a deeper contextual review |

Green CI plus the requested Devin review is the entry point to human review. A
maintainer makes the final call.

Pushing more commits to an open PR re-runs the pipeline; that's expected.

## Finding your way around

Four files, in the order a first change needs them:

| Read | For |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | What the packages are and which one owns the thing you are changing. |
| [`packages/coding-agent/DEVELOPMENT.md`](packages/coding-agent/DEVELOPMENT.md) | The `src/` map: subsystem to directory to the page that documents it. |
| [`docs/README.md`](docs/README.md) | Which documentation tree a page belongs in, and where a new page goes. |
| [`AGENTS.md`](AGENTS.md) | The rules this repository enforces in CI: changelog, tests, class privacy, capture requirements. |

The manual itself is the handbook under [`docs/handbook/`](docs/handbook/). It is the only
user-facing documentation tree: a behavior change updates the page that owns the behavior, in the
same commit. `docs/internal/` is for contributors and is not published.
