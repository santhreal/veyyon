# Backends

A backend runs one trial of one cell and hands the suite what the trial left. The suite names its
backend; the harness declares which backends it binds (`HarnessAdapter.backends`), and a plan that
pairs a harness with a backend it does not bind is refused.

Each backend states the variant axes it applies (`appliesVariantAxes`). An axis it does not apply is
refused when a plan varies it, rather than dropped.

| Backend | Runs a trial | Applies | Used by |
|---|---|---|---|
| `pier` | in a Docker task container, through Pier | config, attachments | `deep-swe` |
| `harbor` | in a Docker or Apple container, through Harbor | none | `terminal-bench` |
| `in-process` | as an agent session inside the runner's process | config, prompts | `typescript-edit` |
| `local-cli` | as one print-mode CLI run on this host, sandboxed | config, prompts, build | `browser`, `miniwob` |

## local-cli

The local-cli backend runs the harness's local command (`HarnessAdapter.localCommand`): for
`veyyon`, `cli.ts -p --mode json --no-session --model <id> --approval-mode yolo --tools <list>
--config <files> <instruction>`, from the build the variant names, or from this checkout. The JSON
event stream on stdout is the trial's record of turns, tool calls and tokens.

Each trial runs in a scratch directory under `/tmp/vey-<uid>/`, outside every project tree, so the
CLI finds no repository context file, settings or git root above its working directory. The root
belongs to the user running the evals, mode 0700; a root another user owns, or a symbolic link in its
place, is refused. The directory name is 12 hex digits of a hash of the trial's record path; it is
short because Chrome aborts when the socket it makes under TMPDIR has a path longer than 107 bytes.
`VEYYON_EVAL_SCRATCH_ROOT` names another root: an absolute path outside every project tree, short
enough that the socket fits (49 bytes at most). A relative path or a longer one fails the trial.

```
/tmp/vey-<uid>/<hash>/
  workspace/   the working directory, with the task's input files
  home/        HOME, empty
  agent/       the credential store and the task's settings
  tmp/         TMPDIR
```

The credential store is a copy of the runner's, holding the model provider's sign-in and nothing
else: no other provider's token, no usage history, no cache. It is pruned once per run and provider,
and each trial writes its own copy. An OAuth access token that expires before a trial's deadline plus
ten minutes is refreshed in the runner's store before the copy is made, so a trial never rotates a
token in its copy alone. The trial inherits `PATH`, the locale, the time zone, proxy variables and
`PUPPETEER_*` from the runner's environment and nothing else, plus what the harness and the suite add.

On Linux the trial runs under Landlock (`backends/local-cli/landlock-exec.py`). It lists every
directory and reads every file except in the runner's home, the runs directory, every other trial's
scratch, this package, the `tests` of the build it runs, the git history of this checkout and of the
build (`.git`, and for a worktree the git directories its `.git` file names), every user's home
(`/home`, `/root`), the system temp directories (`/tmp`, `/var/tmp`, `TMPDIR`) and mounted media
(`/mnt`, `/media`, `/run/media`); it writes only its own scratch, `/dev` and `/proc`. The build, the
Bun runtime, the overlays and the paths a suite names are granted back. A symbolic link beside a
hidden directory is not followed into one. The agent's tools therefore cannot open a grader, a
fixture's source, an earlier trial's transcript, or another user's files. Names in a hidden
directory stay listable, and Landlock does not govern connecting to a Unix socket. On a host without
Landlock the backend refuses the run unless `--unsandboxed` is given.

Landlock rules on this backend cover files, not network connections. A trial reaches every listener
on the host's loopback interface, including the sites and the browser debugging ports of the trials
running beside it, and `/proc/net/tcp` lists their ports. Run with `--jobs 1` when a result must not
depend on what another trial can see or change.

The agent runs in a process group of its own. A deadline or a cancel sends the group SIGTERM, then
SIGKILL to whatever is left once the agent exits or its grace runs out; when the agent exits on its
own, whatever it left in the group is killed. Under Landlock the launcher is the agent's parent and a
child subreaper: a process that leaves the group (a daemon that calls `setsid`, a browser started
detached) is reparented to it, and when the agent exits the launcher kills and reaps every process
left under it. It passes SIGTERM, SIGINT and SIGHUP to the agent and kills the agent 1.5 s later if it
has not exited. On a Linux host without Landlock the launcher runs with no rules and reaps the same
way; without python3, and on every host but Linux, no launcher runs and a process that left the group
is not reached.

Once the run is interrupted by SIGINT or SIGTERM, the teardown is bounded to fit the 10 s the process
has before it exits: 2 s for the agent to exit on SIGTERM, the 2 s output drain, and 3 s for the
suite's `finish`.

When the agent stops, the suite's `finish` runs, the workspace is moved into the trial's record under
the runs directory (copied when the two are on different filesystems), and the scratch is deleted:

```
runs/<run>/<variant>/<task>/repeat-<n>/
  events.jsonl   the JSON event stream
  stderr.txt     the CLI's stderr
  answer.txt     the text of the agent's last message
  workspace/     the working directory as the trial left it
  state.json     what a kit suite's services recorded (kit suites only)
```

An agent that exits non-zero before the provider answered one of its requests (a bad flag, a refused
sign-in, a failed connection, a build that does not start) is an infrastructure error and is
attempted again, whatever its stderr says. A request the provider failed ends in an assistant
message with `stopReason: "error"`; it adds its tokens and is not a turn. A trial that spent its
deadline is an outcome and is graded.

## Builds

`--build main=/src/veyyon-main,head=/src/veyyon` gives each variant its own build. Both arms run in
one plan, interleaved by the worker pool, so host load, network and provider conditions fall on both
alike. A build that is a directory runs `packages/coding-agent/src/cli.ts` in it with the runner's
Bun; a file runs as an executable. The harness checks each build before a trial starts: a directory
without that CLI, a file that is not executable, or a path that does not exist refuses the run. Two
variants whose names are the same once reduced to letters, digits, `.`, `_` and `-` are refused, since
they would share a trial directory.
