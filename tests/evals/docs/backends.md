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

Each trial runs in a scratch directory under `/tmp/vey/`, outside every project tree, so the CLI
finds no repository context file, settings or git root above its working directory. The directory
name is 12 hex digits of a hash of the trial's record path; it is short because Chrome aborts when
the socket it makes under TMPDIR has a path longer than 107 bytes.

```
/tmp/vey/<hash>/
  workspace/   the working directory, with the task's input files
  home/        HOME, empty
  agent/       the credential store and the task's settings
  tmp/         TMPDIR
```

The credential store is a copy of the runner's, holding the model provider's sign-in and nothing
else: no other provider's token, no usage history, no cache. The trial inherits `PATH`, the locale,
the time zone, proxy variables and `PUPPETEER_*` from the runner's environment and nothing else, plus
what the harness and the suite add.

On Linux the trial runs under Landlock (`backends/local-cli/landlock-exec.py`). It lists every
directory and reads every file except in the runner's home, the runs directory, every other trial's
scratch, this package, and the `tests` of the build it runs; it writes only its own scratch, `/dev`
and `/proc`. The build, the Bun runtime, the overlays and the paths a suite names are granted back.
The agent's tools therefore cannot open a grader, a fixture's source, or an earlier trial's
transcript. On a host without Landlock the backend refuses the run unless `--unsandboxed` is given.

When the agent stops, the suite's `finish` runs, the workspace is copied into the trial's record
under the runs directory, and the scratch is deleted:

```
runs/<run>/<variant>/<task>/repeat-<n>/
  events.jsonl   the JSON event stream
  stderr.txt     the CLI's stderr
  answer.txt     the text of the agent's last message
  workspace/     the working directory as the trial left it
  state.json     what a kit suite's services recorded (kit suites only)
```

An agent that exits non-zero before its first turn (a bad flag, a refused sign-in, a build that does
not start) is an infrastructure error and is attempted again. A trial that spent its deadline is an
outcome and is graded.

## Builds

`--build main=/src/veyyon-main,head=/src/veyyon` gives each variant its own build. Both arms run in
one plan, interleaved by the worker pool, so host load, network and provider conditions fall on both
alike. A build that is a directory runs `packages/coding-agent/src/cli.ts` in it with the runner's
Bun; a file runs as an executable. The path must exist when the run starts.
