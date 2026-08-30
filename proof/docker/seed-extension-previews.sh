#!/usr/bin/env bash
# Seed the two extensions whose inspector previews stop short.
#
# The extension inspector previews a context file at 20 lines and a skill
# instruction at 15, and states the remainder in a row. Neither row is reachable
# in a recording unless the project carries a file longer than its cut: the demo
# project has no AGENTS.md, and the recorder profile ships no skills, so the
# inspector opens on rows that fit and the pane never draws the row a capture is
# about.
#
# Both files are ordinary content in the ordinary places -- a project AGENTS.md
# and a native skill under the profile's skills/ directory -- so the surface under
# capture reads them through the product's own discovery. Nothing about the row is
# faked here; the only thing seeded is content long enough to be cut.
set -euo pipefail

DEMO="${1:-/sandbox/home/demo}"
AGENT_DIR="${2:-/sandbox/home/.veyyon/profiles/default/agent}"

# Thirty-four lines, so the preview keeps twenty and reports fourteen gone.
cat >"${DEMO}/AGENTS.md" <<'MD'
# demo

The conventions a session working in this project follows.

## Layout

- `src/parser.ts` trims a focus string and rejects an empty one.
- `src/rate-limiter.ts` is a token bucket; the refill boundary belongs to the caller.
- `src/utils.ts` clamps a number into a window.
- `service/` reads nine numeric settings out of the environment.
- `ship-sim/` is a greenfield build with a specification and executable tests.

## Style

- Tabs, not spaces.
- Name the type; never `ReturnType<>`.
- One concern per commit, staged by path.

## Tests

- `bun test src/parser.test.ts` covers the parser.
- `bun test src/rate-limiter.test.ts` covers the bucket.
- A changed behaviour lands with the test that would have caught it.

## Review

- Read the caller before changing a signature.
- A warning is a defect, not noise.
- Prefer the boring option when both are correct.

## Release

- The version lives in `package.json` and nowhere else.
- A tag publishes; a push does not.
MD

# Twenty-three body lines, so the instruction preview keeps fifteen and reports
# eight gone. The frontmatter is not part of the instruction the preview shows.
mkdir -p "${AGENT_DIR}/skills/release-audit"
cat >"${AGENT_DIR}/skills/release-audit/SKILL.md" <<'MD'
---
name: release-audit
description: Walk a release candidate before it is tagged
---

Audit a release candidate in this order.

1. Read the version in `package.json` and confirm one authority states it.
2. Read the changelog and confirm the top section is unreleased.
3. Run the test bucket that covers the changed packages.
4. Confirm every installer resolves the platform it claims.
5. Confirm the checksum sidecar exists for each published binary.

Report the first failure and stop; a release audit is not a survey.

State, for each step, the command you ran and the bytes you read. A step you
could not run is a blocker and not a pass.

Never tag a commit that has not reached the default branch, because the branch
is what tested it before the tag existed.

Report the audit as a list of steps, each with its command and its result. A
step whose command you did not run is reported as not run, never as a pass.

Stop at the first failure. Every step after it is reported as not reached, so a
reader can tell what was checked from what was skipped.

The audit ends when every step above has a result.
MD
