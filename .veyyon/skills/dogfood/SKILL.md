---
name: dogfood
description: Use the product by hand, as a user, before claiming a feature works. Open this whenever you are about to report that something is done, verified, or green. Drives the real operator path in a real terminal, hunts incoherence between what the product says and what it does, and exercises concurrency and edge cases through actual concurrent use rather than through a harness.
---

# Dogfooding

A green test suite is not a working feature. The suite proves the code does what the test says; it cannot tell you that the feature makes sense, that two surfaces agree with each other, or that the confirmation message is true. Only using the product tells you that.

So before you report that anything works, you use it. By hand. The way the person who asked for it will use it.

## The rule

Run the real operator path, in a real terminal, on a real config directory, and read what it prints. Then do it again in a second process, because most incoherence only appears the second time.

If you cannot show the transcript of yourself using the feature, you have not verified the feature. Say so instead of reporting it done.

## What does not count

These are all useful. None of them is a substitute for using the product, and reaching for one instead is the failure this skill exists to stop.

| Not verification | Why not |
| --- | --- |
| A passing unit or integration suite | Proves the code matches the test, not that the feature is coherent |
| A test harness or stress runner | Someone else's model of the product, one layer away from what a user touches |
| Counting tests, or reporting `N pass / 0 fail` | A number about the suite, not about the feature |
| Reading the source and reasoning about it | You are predicting behavior you could have observed |
| A tmux capture | Banned outright for visuals; see the repo `AGENTS.md` |
| A summary of what other agents reported | Their green is evidence about their lane |

## Isolate before you touch anything

Never dogfood against your own `~/.veyyon`. You will write real credentials, mutate real config, and pollute another running session.

Point `HOME` and the XDG variables at a temporary root:

```sh
sandbox="$(mktemp -d /tmp/veyyon-dogfood-XXXXXX)"
env HOME="$sandbox" \
    XDG_CONFIG_HOME="$sandbox/xdg-config" \
    XDG_DATA_HOME="$sandbox/xdg-data" \
    XDG_STATE_HOME="$sandbox/xdg-state" \
    XDG_CACHE_HOME="$sandbox/xdg-cache" \
    NO_COLOR=1 \
  bun src/cli.ts -p "/secret list"
```

`VEYYON_CONFIG_DIR` does not take an absolute path. It names the config directory *under* your home, so setting it to `/tmp/whatever` builds a doubled path and the CLI refuses with an explanation. Use the XDG variables to move the root onto another volume. Unset `VEYYON_PROFILE` unless the profile is what you are testing.

Print mode (`-p`) reaches slash commands, so `/secret list`, `/settings`, and the rest are drivable without a PTY. Reach for a PTY only when the thing under test is the terminal surface itself.

## Read the real bytes

Output you read through a tool result may be filtered. In this harness, test-runner output is trimmed to failures, and that trimming also applies to a shell redirect, so `cmd > file` can leave a file that is not what the process wrote. Reading the file back gives no hint it was altered.

When the exact output matters, capture it in-process and count what you care about:

```js
const p = Bun.spawn(["bun", "src/cli.ts", "-p", "/secret list"], { cwd, env, stdout: "pipe", stderr: "pipe" });
const out = await new Response(p.stdout).text();
```

Know which instrument read the bytes before you conclude anything from them.

## Hunt incoherence, not crashes

A crash is easy and someone else will find it. What survives to users is the product contradicting itself. Ask these questions while you use the feature:

- **Does the confirmation tell the truth?** It says it saved something. Check that it saved.
- **Do two surfaces agree?** The command, the settings screen, `config get`, and the next session must all describe the same state.
- **Does it survive a restart?** Run the second process. A setting that lives only in memory is a lie in a confirmation.
- **Does the empty state teach you the next step?** Or does it describe a state you are not in?
- **Does the degraded path say it is degraded?** Silent fallback is a product failure. If it cannot do what you asked, the result must say so and the exit status must be honest.
- **Does the feature admit it is off?** A stored credential with obfuscation disabled is worse than no feature, because you believe you are protected.

### Worked example, found this way

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

Three surfaces, two answers. The credential was stored with obfuscation off, which is the one state the feature exists to prevent. No unit test caught it, because each surface was correct on its own; only using them in sequence showed the contradiction. That is the shape you are looking for, and one manual run found it.

## Concurrency by actually running things at once

Do not model a race. Cause one.

Run several real processes against one config root at the same time and see what they do to each other:

- Two `add` calls for the same name, started together.
- An `add` while another process holds the same vault open.
- A read in one process while another rewrites the file underneath it.
- A session already running when you change the setting from a second one.
- A process killed mid-write, then a normal launch on the wreckage.

The bug you are looking for is a process that reports success while another process sees a different truth, or a launch that refuses over a state a healthy peer created. Run each combination more than once; a race that reproduces one time in five is still a defect, and the second run is what tells you which one you have.

## Edge cases worth trying every time

Whatever the feature is, these find real defects:

- The empty case, and the case with exactly one item.
- The very long value, the name with spaces, punctuation, and non-ASCII.
- The expired or lapsed item, at the boundary and just past it.
- The same operation twice in a row.
- The operation on something that does not exist.
- The operation with the feature switched off.
- A file the feature owns, corrupted by hand, then a normal launch.
- A cold start with no config at all, which is what a new user has.

## Report what you did

Write the transcript, not a verdict. Say which command you ran, what it printed, and what does not make sense about it. If nothing is wrong, say what you exercised so a reader can tell how much of the feature that covers.

Then fix what you found, and run the same manual flow again. A fix you have not re-driven by hand is a hypothesis.
