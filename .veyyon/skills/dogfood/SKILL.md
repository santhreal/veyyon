---
name: dogfood
description: Use the product by hand, as a user, before claiming a feature works. Open this whenever you are about to report that something is done, verified, or green. Covers the pre-flight that tells you what to drive, every surface a feature can reach, the ten dimensions a pass has to walk, isolation recipes that do not touch real config or the real working tree, driving the interactive TUI in a real PTY, why the compiled binary is a different program, manual negative controls, how to triage findings, and how to say what you could not verify.
---

# Dogfooding

A green test suite is not a working feature. The suite proves the code does what the test says. It cannot tell you that the feature makes sense, that two surfaces agree with each other, that a confirmation message is true, or that someone who did not read your changelog can find the thing at all. Only using the product tells you that.

So before you report that anything works, you use it. By hand. The way the person who asked for it will use it.

## The rule

Run the real operator path, in a real terminal, on a real config directory, and read what it prints. Then do it again in a second process, because most incoherence only appears the second time.

If you cannot show the transcript of yourself using the feature, you have not verified the feature. Say so instead of reporting it done.

## What does not count

These are all useful. None is a substitute for using the product, and reaching for one instead is the failure this skill exists to stop.

| Not verification | Why not |
| --- | --- |
| A passing unit or integration suite | Proves the code matches the test, not that the feature is coherent |
| A test harness or stress runner | Someone else's model of the product, one layer away from what a user touches |
| Counting tests, or reporting `N pass / 0 fail` | A number about the suite, not about the feature |
| Reading the source and reasoning about it | You are predicting behavior you could have observed |
| A tmux capture | Banned outright for visuals. See the repo `AGENTS.md` |
| A summary of what other agents reported | Their green is evidence about their lane, not about yours |
| The feature working once, on your first try | One happy path, on one host, with warm caches |
| A screenshot of the feature at its defaults | A snapshot is not a differential. It does not show the knob does anything |
| The feature behaving as you expected | Expectation is the thing under test. Look for the contradiction, not the confirmation |

## Pre-flight: find out what you are supposed to drive

Do not start by running the happy path. Start by finding out how many paths there are, or you will drive the one you already had in mind and call the feature covered.

Four cheap lookups, before you touch the product:

**1. Which settings does it add or read?** A setting is declared in `packages/coding-agent/src/config/settings-domains/<domain>.ts`, and if it carries a `ui.condition` the predicate behind that name is registered in `CONDITIONS` in `packages/coding-agent/src/modes/components/settings-defs.ts`. Two different files, so grep both: the first tells you the default and the label, the second tells you what has to be true for the knob to appear at all.

```sh
grep -rn "yourfeature\." packages/coding-agent/src/config/settings-domains/
grep -n "CONDITIONS" -A 20 packages/coding-agent/src/modes/components/settings-defs.ts
```

What comes back is the list you owe an off-and-on differential for, plus the conditions you have to satisfy to see each knob. `config list` cross-checks it against what a running binary actually exposes.

**2. What does the product already claim?** The help text is the contract you are about to test:

```sh
bun src/cli.ts --help
bun src/cli.ts -p "/yourcommand help"
bun src/cli.ts config list
```

Read the option list and the subcommand list as a checklist. Every flag on it is a thing a user will type. `--ttl`, `--scope`, and `--limit` are three more probes you did not know you needed.

**3. What does the handbook say it does?** Read the page before the pass, not after. You are looking for a claim you can go and check, and for a sentence that describes the behavior before your change.

**4. Which surfaces does the code reach?** Use the matrix below. Write the list down. That list is your pass, and its length is how you will honestly describe coverage later.

## Surfaces: drive every one the feature reaches

"Two surfaces agree" is only meaningful once you know what the surfaces are. Mark the ones your change can reach; each marked one gets driven by hand.

| Surface | How you reach it | Why it breaks separately |
| --- | --- | --- |
| Interactive TUI | `bun src/cli.ts` in a real PTY | Rendering, keys, resize, scrollback |
| Print mode | `bun src/cli.ts -p "..."` | No PTY, short-lived process, exits inside debounce windows |
| Slash commands | Both of the above | Shared helper, two ports, easy to wire one and not the other |
| Settings screen | `/settings`, plus `config get` and `config set` | A default that never reaches behavior, a dependent knob visible while its master is off |
| System prompt | `veyyon prompt`, and a real turn | A section rebuilt per turn versus remembered from the conversation |
| Tool renderers | A real turn that calls the tool | Streaming preview and rebuilt transcript are two paths. Fixing one does not fix the other |
| Session resume and export | Start, stop, resume, export | The rebuilt transcript can disagree with what was on screen live |
| Subagents | A task that spawns one | Its own context, its own return seam, its own display |
| ACP and SDK | An ACP request, an embedding host | No terminal, different lifecycle, no interactive fallbacks |
| Extensions and MCP | A configured server or plugin | Third-party input crossing your boundary |
| `veyyon stats` | `veyyon stats` | Separate package, separate worker, separate entry |
| Shell completions | Tab in a real shell | Generated text, drifts silently from the parser |
| Install and update | `install.sh`, self-update | The compiled binary, not your source tree |

A feature that touches four of these and was driven on one is one quarter verified. Say which quarter.

## The ten dimensions

This is what makes a pass exhaustive rather than a spot check. Walk all ten. Most take one command. Skipping one is a decision you should be able to defend out loud.

**1. State.** Empty, exactly one item, many, your maximum, and past it. The empty state has to teach the next step rather than describe a state the reader is not in.

**2. Repetition.** The same operation twice in a row. Does the second run say something different, and is that difference true? Storing, rotating, and replacing are distinct events and only some of them destroyed something.

**3. Absence.** The operation on something that does not exist. On something expired. On something another process just removed.

**4. Off.** The feature switched off, and switched off while its data still exists. A stored credential with protection off is worse than no feature, because you believe you are protected. A degraded path has to say it is degraded, in the operator-visible result and in the exit status.

**5. Restart.** A second process, launched fresh. Everything a confirmation claimed to persist gets checked here, read back through a different surface than the one that wrote it. This is where queued writes, debounce windows, and in-memory-only state are exposed, and it is the highest-yield dimension in this list.

**6. Cold start.** No config at all, which is what a new user has. Then a partial config missing exactly the key your feature reads. Then a config written by an older version.

**7. Hostile input.** Very long values. Names with spaces, punctuation, non-ASCII, combining characters. Tabs and newlines inside rendered content. ANSI escape sequences inside rendered content, because a tool result is attacker-influenced text on its way to a terminal. Paths that are symlinks, contain spaces, or leave the working directory.

**8. Scale.** A large real corpus, not three fixture files. A deep tree. A file that does not fit on screen. Ten thousand results. Cold caches. Quadratic behavior and unbounded allocation both look fine at three files.

**9. Concurrency.** Cause a real race. See below.

**10. Time.** Expiry at the boundary and just past it. A long-running session. An idle session. A clock that moved. Anything with a TTL has a lie waiting at the moment it lapses.

## Isolate before you touch anything

Never dogfood against your own `~/.veyyon`. You will write real credentials, mutate real config, and pollute another running session. The test suite has a tripwire that refuses writes into the real data directory precisely because a test once wrote credentials into it.

Point `HOME` and the XDG variables at a temporary root, in the environment of a **spawned child**:

```sh
sandbox="$(mktemp -d /tmp/veyyon-dogfood-XXXXXX)"
mkdir -p "$sandbox/project"
env HOME="$sandbox" \
    XDG_CONFIG_HOME="$sandbox/xdg-config" \
    XDG_DATA_HOME="$sandbox/xdg-data" \
    XDG_STATE_HOME="$sandbox/xdg-state" \
    XDG_CACHE_HOME="$sandbox/xdg-cache" \
    NO_COLOR=1 \
  bun src/cli.ts -p "/secret list"
```

Four traps, each of which has bitten someone:

- **`HOME` isolates config, not the working tree.** The sandbox protects `~/.veyyon`. It does nothing about the repository the agent is pointed at, so a pass that exercises editing, git, or shell tools is operating on real files. When the feature can write, run it in a scratch project directory.
- **Setting `PWD` does not change the working directory.** `PWD` is an environment variable that a shell maintains as a convenience; the process still starts in whatever directory it was spawned in. Spawning with `env: { PWD: sandbox }` and `cwd: repo` gives you `process.cwd()` of the repo while every log line says the sandbox. Pass a real `cwd`.
- **Assigning `process.env.HOME` inside a running process does not redirect `os.homedir()` in Bun.** It is resolved once at process start. Isolation works only for a child you spawn with that environment, never for the process you are already in.
- **`VEYYON_CONFIG_DIR` does not take an absolute path.** It names the config directory *under* your home, so `/tmp/whatever` builds a doubled path and the CLI refuses. Use the XDG variables to move the root. Delete `VEYYON_CONFIG_DIR`, `VEYYON_CODING_AGENT_DIR`, and `VEYYON_PROFILE` from the child environment rather than assuming they are unset; the suite has `hermeticSpawnEnv()` and `temp-home.ts` for this.

Keep the sandbox path in your report. When something looks wrong the artifacts on disk are the evidence, and the absence of a file is evidence too: a missing `config.yml` is how a lost settings write announces itself.

## Trust your instruments, once you know which ones lie

Every observation arrives through something. Know what it does to the bytes.

| Instrument | Trust for | Distorts |
| --- | --- | --- |
| Raw `Bun.spawn` pipes | Exact bytes, exit codes | Nothing. This is the ground truth for text |
| A tool result in this harness | Rough shape | Test output is trimmed to failures, and the trimming also applies to shell redirects, so `cmd > file` can leave a file that is not what the process wrote |
| A real PTY (`launch` with `pty: true`) | Interactive behavior, keys, layout | Control sequences interleave; read it as a terminal, not as a log |
| `render-proof.ts` images | Colors, fills, spacing | Nothing that matters. Use both grounds |
| tmux | Nothing | Banned. Black ground, stripped styling |

So when exact output matters, capture it in-process and check the exit code as well as the text:

```js
const p = Bun.spawn(["bun", "src/cli.ts", "-p", "/secret list"], { cwd, env, stdout: "pipe", stderr: "pipe" });
const out = await new Response(p.stdout).text();
const code = await p.exited;
```

A command that prints an error and exits 0 is broken in a way no reader of the transcript will notice.

Then read the log file. This package cannot use `console.log`, so a swallowed error goes to `~/.veyyon/logs/veyyon.YYYY-MM-DD.log` under whatever home you sandboxed to. A feature that works while quietly logging a failure every turn is not working.

## Run a manual negative control

The mistake at the end of a good pass is concluding that what you saw was caused by your change. Turn the feature off and drive the same path again. The behavior has to disappear.

```sh
veyyon config set yourfeature.enabled false
# same commands, same inputs
```

If the output is identical with the feature off, you were observing something else and your pass proved nothing. This is the manual twin of reverting a fix to watch its test fail, and it costs one command.

For anything visual, the same rule with images: capture off, capture on, and confirm the two files differ in bytes. A degenerate pair is a failed proof that looks like a successful one.

## Driving the interactive TUI

Print mode reaches slash commands, so a great deal is drivable without a PTY. When the terminal surface itself is under test, use the `launch` tool with `pty: true`, send real keystrokes, and read the output back. That is a real PTY, which is exactly what tmux is not, so it does not fall under the tmux ban. Give the process a real `cwd` and a sandboxed `HOME`.

What to exercise once you are in there:

- Type into the composer, submit, interrupt with Ctrl-C, submit again.
- Tab completion for anything your feature named. If a user cannot discover it by tabbing, they will not find it.
- Resize while output is streaming, then resize back.
- A narrow width (`COLUMNS=40`) and an absurd one. Wrapping and truncation defects live at the edges.
- Paste a multi-line block, and paste something containing an escape sequence.
- Scroll back, then return to the bottom.
- `NO_COLOR=1`, and a `TERM` your renderer does not know.

A readiness pattern that never matches is usually your regex, not a hang. The wordmark is letter-spaced, so `veyyon` does not appear in the output as one word. Read the first frame before concluding the process is stuck.

For appearance, the transcript is not enough. Render the real component and rasterize on both a grey and a black ground with `scripts/demos/render-proof.ts`, and look at the images. An explicit dark fill is invisible on black and reads as a slab on grey, so one ground answers half the question.

## The compiled binary is a different program

Almost everyone runs the binary, and it is not the program you have been testing. Bundling and bytecode compilation change module resolution, workers re-enter the single CLI entrypoint by hidden argv selector, and this repo has a documented history of workers that ran perfectly from source and crashed silently once compiled.

If your change touches a worker, a spawn, an asset, a dynamic path, or anything resolved at runtime:

```sh
bun packages/coding-agent/scripts/build-binary.ts
bun packages/coding-agent/src/cli.ts --smoke-test
```

Then drive your feature through the built binary. `ci:test:smoke` runs `--version`, `--help`, `--smoke-test`, and a source launch. A new worker kind adds its selector to the dispatch table and gets a sibling smoke, or it is unverified on the path users actually take.

## Every setting the feature adds

A setting is a promise that a value changes behavior. Exercise it as one:

- The **default** is honored when nothing is configured.
- **Each non-default value** changes observable behavior. Set it, then observe the difference. If you cannot see one, the setting is dead.
- An **invalid value fails loud** rather than silently falling back.
- The value **persists** across a restart, read back through a different surface than the one that wrote it.
- If the feature is experimental and gated, its **dependent knobs are absent** from the settings screen while the master toggle is off. Not greyed out. Gone.

## Docs, help, and the second operator

Read your own documentation as if you had not written the code: `--help`, the subcommand usage, the handbook page, the README claim, and the error messages on the failure paths. Every one has to describe the behavior you just observed, not the behavior before your change. A stale sentence in a table is exactly as wrong as a stale line of code, and it is the version a user believes.

Then ask the discoverability question: could someone find this without knowing its name, through `/help`, tab completion, the settings screen, or an empty state that points at it? A feature nobody can reach is not shipped.

While you are here, check that each error message names the **fix**, and that it names the fix for the situation the reader is actually in. An error can be correct in refusing and false in explaining, which is worse than an unhelpful message: it sends the reader to re-check something that was already right.

## Concurrency by actually running things at once

Do not model a race. Cause one. Run several real processes against one config root simultaneously:

- Two writes for the same name, started together.
- A write while another process holds the same file open.
- A read in one process while another rewrites the file underneath it.
- A session already running when you change the setting from a second one.
- A process killed mid-write, then a normal launch on the wreckage.
- Two processes racing to create the same thing for the first time.

You are looking for a process that reports success while another sees a different truth, and for a launch that refuses over a state a healthy peer created. Run each combination more than once. A race that reproduces one time in five is still a defect, and repetition tells you which one you have.

## Dogfooding a fix is not dogfooding a feature

For a bug fix the order is fixed, and the first step is the one that gets skipped:

1. **Reproduce it by hand, before touching code.** The transcript of the broken behavior is the artifact. Without it you cannot tell a fix from a coincidence, and you cannot write the regression test, because you do not know what the failure looked like.
2. Fix it.
3. **Re-drive the identical flow.** Same commands, same inputs, same sandbox recipe.
4. Encode the observed failure as a test, then revert the fix and watch that exact test fail. A test that passes with the fix reverted is decoration.

A fix you have not re-driven by hand is a hypothesis.

## Say what you could not verify

Some surfaces need something you do not have: a provider credential, a network, another operating system, a GPU, a paid model. Do not quietly drop those and report the rest as complete.

Name the surface, name what it needed, and say what you substituted. "The `AVAILABLE SECRETS` section is unverified on a live turn; no provider auth in the sandbox. I drove the prompt builder directly and confirmed the section is rendered from the runtime." That is an honest, useful sentence. "Verified" over the same gap is not.

If a claim rests on reading code rather than running it, mark it as inference at the claim, not in a footnote.

## Triage what you find

A pass produces a pile of observations. Sort them before acting, because acting in discovery order wastes the pass.

| Finding | What to do |
| --- | --- |
| A confirmation that says something untrue | Fix now. Highest severity here, because it makes the user confident about a state they are not in |
| A silent fallback, or a degraded path reporting success | Fix now. Surface it in the result and in the exit status |
| Two surfaces disagreeing about one state | Fix now, at the source. Do not patch whichever surface you happened to look at |
| A message with the wrong diagnosis | Fix now. Cheap, and it is the difference between a minute and an afternoon for the reader |
| A doc or help line describing the old behavior | Fix now, in this change. Docs drift is a defect, not a follow-up |
| A missing edge case with a safe outcome | Fix, or a backlog row with acceptance criteria |
| A cosmetic defect outside the change | Backlog row. Do not widen the change |
| Something you cannot reproduce | Say so explicitly, with what you tried. An unreproducible report is still information |

## Clean up

Remove the sandbox when the pass is over, and stop anything you started. A launched TUI left running holds a PTY and a config root, and the next pass will inherit its state and confuse you. Stop it through the tool that started it rather than killing a PID you have not confirmed.

## Report what you did

Write the transcript, not a verdict. Which command, what it printed, what does not make sense about it. Name the sandbox path. Name the surfaces you drove and the dimensions you walked, so a reader can size how much of the feature that represents. If nothing was wrong, that list is the entire value of your report.

Never report "verified" without saying by what. "Tests pass" is not an answer to "did you use it."

## When you have done enough

You are finished when every surface the feature reaches has been driven, all ten dimensions have been walked or consciously skipped with a reason, a negative control confirmed the behavior you saw came from your change, the compiled binary has run the feature if the change could touch it, the docs describe what you observed, and every claim in your report points at an observation rather than an inference.

You are not finished because the suite is green. The examples below all had green suites over them.

## Worked examples

### A confirmation that was not true

Storing a secret reported success and claimed it had turned protection on for good:

```
$ /secret add PROOF_TOKEN --from-env MY_PROOF_TOKEN
Stored PROOF_TOKEN in the profile vault, 1d left.
Secret protection was off, so it is now on for this session and saved for the next one.
```

The next process disagreed, and so did the config:

```
$ /secret list
  #PROOF_TOKEN#  profile  24h left
Secret protection is OFF, so nothing is being obfuscated yet.

$ veyyon config get secrets.enabled
false
```

Three surfaces, two answers, and the sandbox held no `config.yml` at all. The setting write was queued behind a debounce and the short-lived process exited before it landed, so the credential was stored with protection off, which is the one state the feature exists to prevent.

The suite was green: its test asserted the write against a fake with no notion of durability, so the fake and the code agreed and were wrong together. Dimension 5, restart, found it in under a minute. That is the shape you are hunting, each surface correct alone and the sequence incoherent.

### An error that refused correctly and explained falsely

```
$ /secret add OTHER_KEY --from-env BLANK      # with BLANK=""
Error: The environment variable BLANK is not set in this process, so there is nothing to store.
```

`BLANK` was set. It was empty. Unset and set-to-nothing shared one message, so the refusal was right and the explanation was false, which sends the reader to re-check an export that was already correct. The test pinned that message for the unset case only, so it said nothing about the branch beside it.

### The instrument lied, and the pass nearly believed it

A TUI pass launched with a sandboxed `HOME` and `PWD` pointed at a scratch project. The footer read `…/veyyon/packages/coding-agent`, not the scratch directory. `PWD` had been set in the child environment while the process was spawned with `cwd` at the repo, so config was isolated and the working tree was not: an agent exercising an editing feature there would have been editing the real repository while the recipe looked airtight.

Nothing failed, no test could have caught it, and the only reason it surfaced is that a footer was read carefully instead of skimmed. Check the environment your process actually got, not the one you passed.
