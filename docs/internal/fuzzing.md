# Fuzzing

The suite lives in [`fuzz/`](../../fuzz/). It is a set of coverage-guided fuzz targets built with
[cargo-fuzz](https://rust-fuzz.github.io/book/cargo-fuzz.html), aimed at the Rust crates under
`crates/`. This page tells you how to run it, what each target covers, and what to do when one of
them finds something.

For the property-based tests that run as part of the normal suite (fast-check in TypeScript), see
[testing.md](testing.md). Those and this are different tools for different jobs: fast-check proves a
property over a few thousand generated cases every time you run the suite, and a fuzzer explores for
hours looking for the input nobody thought of. You want both.

## Running it

You need a nightly toolchain and `cargo-fuzz`:

```bash
rustup toolchain install nightly
cargo install cargo-fuzz
```

Then run every target for a minute each:

```bash
bun scripts/fuzz.ts run
```

That builds the targets, runs them several at a time, writes each one's output to
`fuzz/logs/<target>.log`, and prints a line per target saying whether it found anything. A finding
leaves a reproducer file in `fuzz/artifacts/<target>/`.

A real campaign is the same command with a longer clock. An hour per target, four at a time:

```bash
bun scripts/fuzz.ts run --seconds=3600 --jobs=4
```

Other subcommands:

| Command | Does |
| --- | --- |
| `bun scripts/fuzz.ts list` | Print the target names. |
| `bun scripts/fuzz.ts build` | Build every target without running it. |
| `bun scripts/fuzz.ts run <target>` | Run one target, or several named ones. |
| `bun scripts/fuzz.ts cmin` | Shrink each corpus to the smallest set with the same coverage. |
| `bun scripts/fuzz.ts coverage <target>` | Produce a coverage report for one target. |

Build artifacts go to `/mnt/FlareTraining/santh-archive/cargo-target/veyyon-fuzz` by default, off the
Santh share, because a sanitizer build writes tens of gigabytes. Set `CARGO_TARGET_DIR` to move it.

Naming targets builds only those targets. That matters more than it sounds: an unqualified build
compiles every target, and the ones that link `veyyon-shell` pull the whole vendored uutils tree
through a sanitizer build at one codegen unit, which is enough to have the compiler killed for
memory on a workstation. If you want one target, name it and you pay for one target.

Build parallelism is bounded to half the cores for the same reason, and `--build-jobs=<n>` overrides
it. This is separate from `--jobs`, which is how many fuzzers RUN at once; a sanitizer build is
memory-bound and a fuzzer run is not, so the two want different numbers.

## The targets

| Target | Crate | Covers |
| --- | --- | --- |
| `walker_path_order` | `veyyon-walker` | `compare_depth_first_paths`, `is_relative_ancestor`, `sort_collected_depth_first`. |
| `walker_glob` | `veyyon-walker` | `CompiledWalkGlob` compilation, matching, and its `Eq`/`Hash` cache-key contract. |
| `ast_apply_edits` | `veyyon-ast` | `apply_edits`, which splices rewrite results back into a source file. |
| `ast_parse_and_match` | `veyyon-ast` | `compile_pattern` and `collect_matches` across six grammars. |
| `minimizer_filters` | `veyyon-shell` | The whole `minimizer::filters` dispatch, every program arm. |
| `minimizer_lint_condense` | `veyyon-shell` | `condense_lint_output` and `group_diagnostics`. |
| `minimizer_detect` | `veyyon-shell` | `detect` and `detect_tokens`, the router that picks which filter sees a capture: that the identity is lowercase, that it is carried by a token rather than invented, that the string and argv entry points agree, and that a launch prefix or a trailing `; …` cannot change it. |
| `minimizer_primitives` | `veyyon-shell` | `minimizer::primitives`, which every filter is built out of: that each capping primitive conserves the number of original lines it stands for and reports that number in its marker, that head keeps a prefix and tail keeps a suffix, that dedup's `(×N)` counters add back up, that a line already carrying a counter has that counter MULTIPLIED rather than gaining a second one (`warn (×3)` twice is `warn (×6)`, not `warn (×3) (×2)`), that collapsing blank runs drops no content, and that all of it settles after one pass. |
| `keys_parse` | `veyyon-keys` | Kitty and legacy terminal escape sequence parsing, and the agreement between its four entry points. |
| `glob_patterns` | `veyyon-glob` | Pattern normalization, and whether the match fast paths agree with the glob engine. |
| `text_measure` | `veyyon-text` | Wrapping, truncation, column slicing, and segment extraction over arbitrary UTF-16, including the width invariants each one promises. |
| `ast_block_range` | `veyyon-ast` | `block_range_at` and `enclosing_block_boundaries`, the spans the `replace block` operator overwrites. |
| `diff_kernel_unified` | `veyyon-diff-kernel` | `split_lines`, `Ignore::key` and `Unified`, the one place two texts become patch text: that splitting a text into lines loses nothing, that a run with no ignore flag differs exactly when the bytes differ, that the verdict agrees with whether anything was printed, that the key transform is idempotent, that each flag's own promise holds on its output, and that `-w` subsumes the narrower whitespace flags. |
| `iso_git_diff_parse` | `veyyon-iso` | `parse_git_diff`, the byte parser that splits `git diff` output into per-file entries, and the slicing contract that keeps each entry applicable. |
| `uu_diff_argv` | `veyyon-uu-diff` | `uu_app()` argument parsing over arbitrary argv, including non-UTF-8 arguments. |
| `uutils_ctx_scope` | `veyyon-uutils-ctx` | `scope`, `resolve`, `var` and `format_usage`: the path and environment shim every embedded uutils builtin reads through. |
| `uu_grep_argv` | `veyyon-uu-grep` | `try_parse_argv` for both `grep` and `rg`, including the `-NUM` context shorthand rewritten before clap sees it. |

Each target file opens with a comment saying what is under test and why it is worth fuzzing. Read
that before changing one.

## Why these and not the others

The pure Rust crates are fuzzable directly because they are `rlib`s. `veyyon-natives` is not: it is
declared `crate-type = ["cdylib"]` and its functions are N-API entry points, so linking it into a
fuzz binary would leave the `napi_*` symbols undefined. That matters, because some of the code most
worth fuzzing was living there.

The answer is not a workaround, it is to move the logic out. `crates/veyyon-keys` is the first one
done: the escape-sequence parser was 1,600 lines inside `veyyon-natives/src/keys.rs` that nothing
could link, and it is now an ordinary crate with the N-API file reduced to a 120-line wrapper that
only converts types. `keys_parse` fuzzes it, and its unit tests run under `cargo test` for the first
time. `crates/veyyon-glob` is the second: `glob_util.rs` rewrote glob patterns by string surgery and
chose a match fast path, and the N-API file is now three functions that convert a `GlobError` into a
napi `Error`. `crates/veyyon-text` is the third and the largest: 1,800 lines of ANSI-aware width
arithmetic over UTF-16 that every rendered row in the TUI goes through, and every byte of it came
from a terminal, which is exactly the input you want a fuzzer choosing. Its one API change is that
`truncate_to_width` answers `Option<Vec<u16>>` rather than a string, where `None` means the input
already fits; that is what lets the N-API wrapper keep handing the caller's original `JsString` back
without allocating.

That is every file behind the boundary that held logic of ours. `tokens.rs`, `html.rs`, and
`sixel.rs` stay where they are on purpose: each is an adapter over a third-party crate
(`tiktoken-rs`, `html_to_markdown_rs`, `icy_sixel`) and owns no decision of its own, so extracting
one would produce a crate containing a function call and a target that fuzzes someone else's code.
If one of them ever grows a decision, a format sniffer or a chunking rule, that decision is what
moves out.

The rule that falls out of this: if a piece of logic can only be reached through the N-API boundary,
it cannot be fuzzed, benchmarked, or unit tested, and that is a reason to move it rather than a fact
to accept. Keep `veyyon-natives` to type conversion.

### The uutils builtins, and what must not be fuzzed

`veyyon-uu-diff` and `veyyon-uu-grep` are whole command-line utilities running in-process as shell
builtins, so their obvious entry point is the wrong one. Each exposes `run(argv) -> i32`, and `run`
opens files, walks directories and writes to the scope's stdout. A fuzzer calling it would be
generating filesystem operations rather than inputs, on the machine running the fuzzer, at a few
thousand executions a second. Do not fuzz `run`.

What you fuzz instead is the part that decides: argument parsing. `veyyon-uu-diff::uu_app()` builds
the `clap` command, and `try_get_matches_from` over arbitrary argv touches nothing. It has a real
contract, too, which is that it answers `Ok` or `Err` and never panics. `clap` panics rather than
errors on a misconfigured command, so a duplicate long flag, a short flag defined twice, or a default
value that fails its own validator shows up as a crash the moment the fuzzer reaches the argument
that reveals it. That is what `uu_diff_argv` exists to catch, and it is why the target feeds
`OsString`s built from raw bytes rather than `&str`: on Unix an argument does not have to be UTF-8,
and the paths that handle a non-UTF-8 argument are the ones nobody types by hand.

`veyyon-uu-grep` needed a small change before the same rule could be applied to it. Its two commands
parsed inline in `run`, so there was no way to reach the parse without also reaching the search. Both
now expose `try_parse_argv`, which performs exactly the parse `run` performs and returns only whether
it was accepted. On the `grep` side that is one private `parse` function with two callers, so the
fuzzed parse and the shipped parse are the same code rather than two things that agree today and
drift tomorrow.

`grep` also has a step before clap: `normalize_context_args` rewrites the `-NUM` context shorthand,
because `grep -3` is a valid invocation that clap would reject. It is public for the same reason, since
anything examining the argument surface without it is examining a different command than users get.

`veyyon-uutils-ctx` sits underneath both of them. It is the shim through which every embedded utility
resolves a relative path and reads an environment variable, so a defect there is not one utility
misbehaving, it is all of them reading a different working directory than the shell they are running
in. `resolve` is pure path arithmetic and `scope` is a thread-local install-and-restore, which makes
the whole thing fuzzable without a filesystem: `uutils_ctx_scope` checks that an absolute path comes
back unchanged, that a relative one lands under the scope's working directory, that the environment
map answers exactly what was put into it, and that the scope is fully torn down afterwards, since a
leaked context would silently give the next builtin the previous one's working directory.

## The TypeScript fuzzers

`cargo-fuzz` covers the Rust crates. The TypeScript side has its own set, hand-rolled: about ten
suites named `*-fuzz.test.ts` that build adversarial strings from the shared pool in
`packages/utils/src/adversarial-strings.ts` and run a few thousand iterations against a parser or a
renderer.

They used to hardcode their seed, which meant every run replayed the identical inputs. That covers
whatever the first run happened to cover and never reaches input 8,001, however many times CI runs
it. Each call site now passes its constant through `fuzzSeed`, which mixes it with a per-run nonce,
so consecutive runs explore different inputs.

You do not lose reproducibility. The nonce is printed once per process:

```
fuzz seeds: VEYYON_FUZZ_SEED=0x091399e5 replays this run
```

Set that variable to the printed value and every suite in the run replays exactly. Two special
cases are worth knowing:

- `VEYYON_FUZZ_SEED=0` is the deterministic mode. Every call site gets back the constant written in
  its source, which is the input set those suites ran before any of this existed, and it is what you
  want while bisecting.
- A malformed value throws. A mistyped seed pasted from a CI log would otherwise run a different
  input set and report that the bug is gone.

### Shrinking and the corpus

Write a TypeScript fuzzer with `fuzzStrings` from the same module rather than a hand-written loop:

```ts
import { fuzzStrings } from "@veyyon/utils/adversarial-strings";

fuzzStrings({ seed: 0x9e37_79b9, iterations: 4000, corpus: WORDWRAP_CORPUS }, input => {
	const wrapped = wrap(input, 40);
	expect(wrapped.join("")).toBe(input);
});
```

The callback receives one adversarial string and asserts on it. Throwing is a failure, exactly as in
a plain loop, so moving an existing fuzzer onto this is a mechanical change. What you get back is
the two things a hand-rolled loop cannot give you.

**Shrinking.** A generated input is up to 24 fragments of lone surrogates, truncated CSI sequences
and ZWJ clusters, and the fragment that broke your parser is one of them. When the callback throws,
`fuzzStrings` re-runs it against progressively smaller inputs, first dropping halves and then single
code points, and keeps the shortest input that still throws. The reported failure is that minimal
input, not the 300-character string that happened to contain it. The message also carries the
original length, so you can see how much was noise.

**A corpus.** The failure message ends with a paste-ready line:

```
corpus entry: "]66;s=2;\ud800"
```

Put that string in the suite's exported corpus array and it is replayed first on every run, before
any generated input, forever. That is the durable half: a fuzz find that stays a fuzz find is only
found again by luck, and a run that starts by replaying every past failure cannot silently lose one.
Corpus entries run under every seed, including `VEYYON_FUZZ_SEED=0`.

Keep each corpus in the suite that owns it, as a `const` beside the `fuzzStrings` call, with a
comment naming the bug the entry locks out. There is no corpus directory and nothing is written at
runtime: a test that writes files fails differently in CI than it does locally, and a checked-in
literal shows up in review where a generated file does not.

If your invariant only holds over a narrower alphabet than the shared pool, pass `build`:

```ts
fuzzStrings({ seed: 0x0bad_f00d, iterations: 6000, build: buildSafeString }, (input, rand) => { ... });
```

The second argument to the check is a generator for anything else the case needs, such as a column
or a width. It is rebuilt identically on every replay of the same case, so drawing from it stays
deterministic while the input shrinks. Do not close over the outer generator instead: shrinking
would advance it and check a different case than the one that failed.

### When the case is not a string

Some units under test take a structure, not a string. `bracketed-paste-fuzz` generates a pasted
stream together with the marker offsets inside it and a chunking of that stream; `deccara-fuzz`
generates a line together with the width it must fill. Shrinking the string alone would report an
input that no longer matches its own parameters, which reads as a second bug.

`fuzzCases` is `fuzzStrings` for those. You give it how to build a case and how to simplify one, and
it does the rest: the corpus first, then generation, then minimisation, then the same failure
report.

```ts
fuzzCases<Stream>(
    {
        seed: 0x9e37_79b9,
        iterations: 8_000,
        corpus: PASTE_REGRESSIONS,
        build: rand => buildPasteStream(rand),
        // Every candidate a case can be simplified to, biggest reduction first. Each must still be
        // a VALID case: drop a whole paste, drop a segment, merge two chunks. Never edit the stream
        // text without updating the offsets that describe it.
        simplify: stream => [...withOnePasteRemoved(stream), ...withMergedChunks(stream)],
        describe: stream => JSON.stringify(stream.chunks),
    },
    (stream, rand) => {
        // assert conservation
    },
);
```

`simplify` returns candidates rather than performing the search, so the driver keeps one
minimisation strategy for every domain: it tries them in order, takes the first that still fails,
and repeats from there, stopping once no candidate fails. Ordering them biggest-reduction-first is
what makes it converge quickly. Returning the case itself is harmless: the driver skips any
candidate it has already tried, so a `simplify` that can cycle cannot hang the run.

`describe` is how the failure names the case. Without it the report falls back to `JSON.stringify`,
which is usually right and is unreadable for a case holding a large buffer.

## Reading coverage

A campaign that finds nothing tells you one of two things, and they call for opposite responses: the
code is solid, or the fuzzer never reached it. Coverage is how you tell them apart.

```bash
bun scripts/fuzz.ts coverage text_measure
```

That runs the target over its whole corpus under `-Cinstrument-coverage` and leaves a profile under
`coverage/<target>/` in the fuzz target directory. Turn it into something readable with the LLVM
tools from the same nightly toolchain that built it, or the line numbers will not line up:

```bash
cargo +nightly fuzz coverage text_measure
rustup run nightly llvm-cov show \
  target/x86_64-unknown-linux-gnu/coverage/x86_64-unknown-linux-gnu/release/text_measure \
  --instr-profile=fuzz/coverage/text_measure/coverage.profdata \
  --show-line-counts-or-regions --ignore-filename-regex='/\.cargo/' > /tmp/text_measure.txt
```

Read it for zero-count REGIONS, not for a percentage. A high line percentage next to an uncovered
error branch is the exact shape of a target that only ever exercises the happy path. What an
uncovered region means depends on which kind it is:

- **The generator cannot produce the input.** Add the shape to the target's `Arbitrary`
  implementation in `fuzz/src/lib.rs`. This is the common case and the reason coverage is worth
  reading at all: the alphabet, not the runtime, is usually what bounds a campaign.
- **The input is producible but rare.** Seed the corpus with a file that reaches it, then let
  libFuzzer mutate from there.
- **The code is unreachable.** That is a finding in its own right: either it is dead and should go,
  or the caller that would reach it is missing.

The coverage build is capped to half the cores like every other sanitizer build. Uncapped it
compiles at `codegen-units=1` on every core with instrumentation on top and rustc is killed by the
kernel, which surfaces as `could not compile <some dependency>` and reads as a broken toolchain
rather than as an out-of-memory. `--build-jobs=<n>` overrides the cap.

## Writing a target

Put the file in `fuzz/fuzz_targets/`, add a `[[bin]]` entry for it in `fuzz/Cargo.toml`, and it is
picked up automatically. `scripts/fuzz.ts` reads the target list out of that manifest, so there is no
second list to update.

Two things decide whether a target is any good.

**The generator.** A target that takes `&[u8]` and lossily converts it to a string spends its whole
run in a region of the input space the code treats identically. `fuzz/src/lib.rs` holds the shared
generators, and each one is built around a specific distinction the code under test makes. `PathLike`
draws from an alphabet heavy in `/` and the bytes either side of it, because that is what a path
comparator gets wrong. Reach for one of those, or add one and say what it is for.

**The property.** "It did not panic" is a real property and worth having, but it is the weakest one
available. The targets here also assert the things that fail quietly: that a filter reporting
`changed: true` really did change the text, that byte counts describe the strings actually returned,
that running the same input twice gives the same answer, that condensing twice is the same as
condensing once. Those are the assertions that catch a bug that ships.

State the property at the precision that makes it true. `minimizer_lint_condense` first asserted that
condensing never grows the output in bytes, which found a real bug (a run of blank lines was coming
back as a line reading ` (×2)`) and then kept firing on `a\na\n` becoming `a (×2)\n`, which is
correct behaviour: the counter costs six bytes and tells you the program repeated itself. The fix was
not to drop the property but to split it. Line count never grows, for any input. Byte count never
grows for whitespace-only input, where no annotation can be worth anything. A property you have to
weaken to get a clean run was measuring the wrong thing; find the version of it that is actually
true, because that is the one with teeth.

## What it has found

Four bugs on the first run, each fixed with a named regression suite in the crate that owns the code:

- `compare_depth_first_paths` in `veyyon-walker` was not a total order, and it feeds
  `slice::sort_unstable_by`. Any directory with a hyphenated or dotted sibling (`src`, `src/x`,
  `src-gen`) was a broken triple.
- `apply_edits` in `veyyon-ast` panicked instead of returning `Err` when an edit offset landed inside
  a multi-byte character, so any source file with a non-ASCII character could abort the process.
- A bare `$$$` pattern compiled and then panicked inside ast-grep-core at match time, reachable from
  an ordinary `ast_grep` tool call.
- `dedup_consecutive_lines` in `veyyon-shell`, a primitive that ten output filters call, turned a run
  of blank lines into a line reading ` (×2)` and spliced it into the agent's transcript.

The second run then found a fifth, and it is the more useful story. The fix for the `$$$` pattern was
a syntax check that rejected a pattern whose whole text was an ellipsis. The fuzzer came back with
`+$$$`, which is not a bare ellipsis by any textual reading and panics in the same place. Enumerating
shapes was never going to work, so the guard became a probe: compile the pattern, run it against a
trivial source inside `catch_unwind`, and turn a panic into an error carrying the matcher's own
message. Re-run your target against your own fix. A guard built from the examples the fuzzer already
gave you is fitted to those examples.

That lesson kept applying. Later runs found, in order: `matches_key` lowercasing a binding so that a
capital letter matched the wrong key and not itself; the eslint condenser deleting its own repeat
counter and returning the empty string for output that had something in it; `parse_key` emitting
`alt+alt+shift+o`, an id no binding can parse; a glob fast path answering `false` where the glob
engine answered `true`; and the `$$$` probe turning out to be incomplete after all, because the
upstream assert depends on the candidate node as well as on the pattern. Each fix was verified by
re-running its target, and three of those five runs came back with a NEW crash in the same target
rather than a clean sheet. Budget for that: the first fix in an area is rarely the last one.

## What to do with a finding

A crash leaves a file in `fuzz/artifacts/<target>/`. Reproduce it with:

```bash
cargo +nightly fuzz run <target> fuzz/artifacts/<target>/<file>
```

Then shrink it:

```bash
cargo +nightly fuzz tmin <target> fuzz/artifacts/<target>/<file>
```

The artifact is not the deliverable. Once you have a minimal input, write a named regression test in
the crate that owns the code, asserting the real values, and fix the bug. The artifacts directory is
gitignored on purpose: a binary blob in a directory nobody reads is not coverage, and a test named
after the bug is. Record the finding in `BACKLOG.md` the moment you have it, before you start on the
fix.

## Triaging a pile of artifacts

After a few campaigns the artifacts directory holds more crashes than you can read, and most of them
are not new. `scripts/fuzz-triage.ts` reduces the pile:

```bash
bun scripts/fuzz-triage.ts report
```

It runs each artifact back through its target against the current tree, drops the ones that no longer
crash, and groups the rest by crash signature rather than by input. That last part matters more than
it sounds: libFuzzer writes one artifact per crashing input, and one root cause produces many. On
2026-07-25 there were nine artifacts on disk representing four distinct bugs, four of them already
fixed.

`bun scripts/fuzz-triage.ts issues` prints a ready issue body per distinct crash. The body carries the
reproduction command, every artifact that shares the signature, and the constraints on a fix: do not
weaken the assertion that caught it, do not edit anything under `fuzz/`, and land a regression test
that fails before and passes after. Those constraints exist because the cheapest way to make a crash
stop is to stop checking for it.

Filing is a separate command and never runs on its own:

```bash
bun scripts/fuzz-triage.ts file
```

It asks before each issue and there is no flag to skip the prompt. The PR that fixes one is never
merged automatically; the issue body says so, and it is the reason the constraints are written into
it rather than left to convention.

### Suppressions

`fuzz/known-harness-signatures.toml` lists crash signatures that are artefacts of the harness rather
than bugs. It ships empty, and the reason is instructive. libfuzzer-sys installs a panic hook that
aborts before unwinding, so code whose contract is "turn a panic into an error" crashes the fuzzer
while behaving correctly, and `compile_pattern` does exactly that. An entry for the resulting
signature was written and then removed: the identical assert is also reachable from `collect_matches`
on a real call path, and a substring filter cannot tell the two apart, so the entry would have
permanently hidden a live bug. The rule is that a signature reachable from both the harness and the
code does not belong in that file. Fix it in the target, where the suppression can be scoped to the
one call allowed to panic, which is what `ast_parse_and_match` does.

## Where the suite sits relative to the build

`fuzz/` is its own cargo workspace, not a member of the root one. Every target is a binary that links
libFuzzer, which supplies its own `main` and needs `-Zsanitizer=address` to build at all; as a
workspace member, a plain `cargo build --workspace` would try to link those binaries without the
sanitizer flags and fail for everyone who never runs a fuzzer. The cost of detaching is that
`fuzz/Cargo.toml` repeats the root `[patch.crates-io]` section, because cargo only honours `[patch]`
at a workspace root. Keep the two in sync, or the fuzzers resolve a different `brush-core` than the
one that ships.

The suite is not part of `bun run check` and does not gate a commit. It is a campaign you run
deliberately, usually for hours, usually on a machine with cores to spare.

*Verified against `ad7ede4a` on 2026-07-28.*
