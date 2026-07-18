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

## What happens to your PR

Every PR runs the full CI suite before a human looks at it:

| Stage | What it does |
| --- | --- |
| **Checks** (`checks.yml`) | Biome lint + type check, TypeScript workspace tests |
| **CI** (`ci.yml`) | Native addon builds, Rust + TS test matrix, install-method smoke tests |
| **Security** (`security.yml`) | keyhog secret scan, `cargo deny`, `cargo audit`, `bun audit`, CodeQL SAST |
| **Autoreview** (`autoreview.yml`) | santh-bot (qodo pr-agent) posts an AI review, description, and improvement pass |
| **veybot** | The in-repo review bot posts a deeper contextual review |

Green CI plus the automated review is the entry point to human review — it is
not a merge gate on its own. A maintainer makes the final call.

Pushing more commits to an open PR re-runs the pipeline; that's expected.
