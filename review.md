# Reviewing a pull request

Read the diff against the code it changes, not on its own. A hunk that looks correct in isolation is
the usual way a defect lands.

State findings as a numbered list. Each finding names the file and line, what breaks, and the input
or sequence that breaks it. A finding you cannot demonstrate is a question, not a finding, and is
labeled as one.

Approving is a claim that you checked the sections below. Do not approve a diff you did not read in
full.

## Order

Cheap and disqualifying first, so a malicious or broken change is rejected before anyone reads it for
style.

1. Provenance and intent
2. Security
3. Correctness
4. Complexity
5. Maintainability
6. Tests
7. Documentation

## Provenance and intent

Check that the diff does what the description says and nothing else. An unexplained change outside
the stated scope is the finding, whatever the change is.

Reject on sight:

- A network call, subprocess, or filesystem write added to a change that needed none.
- An encoded, minified, or generated blob no one can read, added by hand.
- A new dependency that is a typosquat of a real one, is days old, has one publisher and no source
  repository, or resolves to a fork rather than upstream.
- A change to CI configuration, a lockfile, an install script, or a release script bundled with an
  unrelated fix. Those land alone, so they are reviewed alone.
- A postinstall or prepare script added to any manifest.
- A credential, token, or endpoint written into source.
- A test weakened, deleted, or skipped so the diff passes.

A diff that reads a file to obtain a value and sends that value anywhere is exfiltration until proven
otherwise. Ask what the value is and where it goes.

Read every file in the diff, including files a reviewer skims: fixtures, snapshots, `.github/`,
scripts, and generated output. A payload goes where nobody looks.

## Security

- Every boundary validates its input: CLI arguments, environment, config, network responses, MCP
  payloads, plugin manifests, and anything a model emits.
- A security control fails closed. A `catch` that returns a permissive default is a hole.
- No secret reaches a log, an error message, a transcript, a session file, or a crash report.
- A path from user or model input is resolved and confined before use, so `../` cannot escape the
  directory the code intends.
- A spawned command takes an argv array. A string interpolated into a shell is a finding.
- A regex fed unbounded input terminates. Nested quantifiers over untrusted text are a finding.
- Deserializing untrusted data constructs no code and no prototype chain.
- A change to trust, approval, sandbox, or permission logic is reviewed as its own concern, not as
  part of a feature.

## Correctness

- Trace the failure paths, not the success path. What happens on a rejected promise, a non-zero exit,
  a truncated stream, a missing file, an empty array?
- An error is surfaced or handled. Swallowing one is a finding; so is `catch` that logs and continues
  into code the failure invalidated.
- Anything with a deadline, retry, backoff, or queue terminates, and the bound is stated.
- Concurrent work that touches shared state states what serializes it.
- A persisted shape that changed carries a version bump and rejects the stale copy.
- Two surfaces reporting on the same state agree. One reading a different source than its sibling is
  the defect that produces "installed here, not installed there".

## Complexity

The question is not whether the code is clever. It is whether a simpler version does the same job.

- An abstraction with one implementation is premature. Name the second caller or inline it.
- A configuration option nobody sets is dead. A flag that never reaches behavior is dead.
- A layer that forwards its arguments unchanged is removable.
- A cache needs a stated invalidation rule, or it is a correctness bug waiting.
- Defensive code for a state the type system already excludes is noise.
- Rewriting an area the diff did not need to touch hides the real change. Ask for the split.

## Maintainability

- Names state what the value is, not how it is stored.
- A comment explains why, because the code already states what. A comment restating the line is
  deleted; a comment naming the defect a branch prevents is kept.
- One owner per constant, parser, schema, and primitive. A second definition beside an existing one
  is a finding.
- Domain logic does not import CLI, transport, or UI.
- Dead code is deleted in the same change, including the alias, the re-export, and the compatibility
  shim.
- Follow the conventions in [`AGENTS.md`](AGENTS.md): class privacy, barrels, prompts in `.md`
  files, the Bun surface, and logging through the logger rather than `console`.

## Tests

- Every changed observable behavior has a test that fails without the change. A test that passes
  against the unfixed code proves nothing.
- The test drives the production path. A test whose subject is a mock of the thing under test is not
  evidence, and neither is asserting that a spy was called. Both are enforced by
  `scripts/a-test-proves-behavior-not-that-a-spy-was-called.test.ts`: `mock.module` is refused
  outright, and a spy-call assertion is refused in any file that did not already carry one. A count
  in its ledger may only fall, so do not raise one to land a diff.
- A variant space is enumerated from source at run time, so a new member turns the suite red rather
  than slipping past a hardcoded list.
- No source-grep assertions, no tautologies, no "the code ran" checks.
- Tests are full-suite safe: no long-lived mutation of `process.env`, `Bun.*`, or `process.platform`
  where a narrower seam exists.

[`docs/internal/testing.md`](docs/internal/testing.md) is the reference; `AGENTS.md` states the
enforced rules.

## Documentation

- The document that owns the changed behavior is updated in the same change.
- The package changelog has a bullet, one flat declarative sentence.
- A claim in a document matches the code, including help text, README statements, and the settings
  reference.

## What is not a finding

Do not spend review on these:

- Formatting, import order, and anything `biome` rewrites.
- Changelog section order, which the release workflow fixes.
- Style preference where the repo has no stated convention.
- A clippy lint with no defect behind it.

## Verdict

- **Approve** when every section above holds.
- **Request changes** with the numbered findings. Separate what blocks merge from what does not.
- **Reject** for anything in "reject on sight", and say which item it hit.

Report which variants you tried to smuggle past the tests and whether each was caught, so a reader
knows what the review actually covered.

*Verified against `5efaf1d5f` on 2026-08-24.*
