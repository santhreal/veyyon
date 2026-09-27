# Experiments

An experiment compares arms: a baseline and one or more candidates that differ in one thing. The
evals run every arm on the same tasks with the same seeds in one plan, and report the difference with
its uncertainty. Choosing what to try is a person's call; the evals make the trial cheap and the
verdict honest.

## What an arm can vary

| Arm | Flag | Example |
|---|---|---|
| a build of the agent | `--build` | `--build main=/src/veyyon-main,head=.` |
| settings | `--config` | `--config arms/baseline.yml,arms/candidate-bash-trim.yml` |
| prompt text | `--prompts` | `--prompts terse.yml`, a YAML map of prompt id to replacement text |
| the model | `--model` | `--model provider/a,provider/b` |
| the harness | `--harness` | `--harness veyyon,omp` |

`arms/` holds settings overlays. An overlay changes one variable against the defaults, so a
difference has one cause. Companion files beside `<name>.yml` override system prompt sections
(`<name>.sections.yml`), statements (`<name>.statements.yml`), registered prompts
(`<name>.prompts.yml`), or mount a rule file (`<name>.rule.md`), on the backends that apply them.

## Running one

```sh
bun evals.ts --suite browser --model google-antigravity/gemini-3.8-flash \
  --build main=/src/veyyon-main,head=/src/veyyon --repeats 3 --jobs 4 --run-id browser-main-vs-head
```

- Arms run interleaved in one plan, so host load, network and provider conditions fall on each arm
  alike. Two runs made at different times are not a paired comparison.
- The same task and repeat get the same seed in every arm; a kit suite derives its data from that
  seed. Repeats get different seeds, so three repeats are three instances of each task.
- `--repeats` sets the sample. With a pass rate near the middle, a difference of a few tasks is inside
  the noise of one repeat.
- Use `--dry-run` first: it prints the variants and every preflight verdict.

## Reading the report

A kit suite writes `report.md` and `summary.json` into the run directory.

- **Arms**: passes, pass rate with its Wilson 95% interval, mean partial credit, errors (trials
  that never reached a grade), timeouts, and the tokens, turns and seconds spent.
- **Capability** and **Difficulty**: passes per capability and per difficulty, per arm.
- **Passes within turns, tokens, seconds**: how many trials passed within each budget of the
  suite's ladders, which `summary.json` records. An arm that passes the same tasks in fewer turns
  moves left on these curves while its pass rate holds.
- **Paired against the first arm**: over the task-and-repeat pairs both arms graded, the pairs only
  the candidate passed, the pairs only the baseline passed, the exact two-sided sign test p-value on
  those, and the change in tokens, turns and seconds summed over the pairs. A pair with an error on
  either side is left out, so an error never counts for or against one arm.

Tokens are every token the provider processed: input, cache reads and writes, and output.

`bun evals.ts tool kit-report --run runs/<run-id>` renders the report again, and `--regrade` first
grades every trial again from its `state.json` and `answer.txt` with the checks as they are now,
writing `report-regraded.md` and `summary-regraded.json` beside the run's own. A run copied to
another host is read from its trial directories under `--run`. The tool fails when the run
directory holds no readable `run.json`, since the arms' order, and so the baseline, comes from it.

## Rules that keep a result honest

- Compare arms from one run. Rerun both arms when one changes.
- Change one thing per arm.
- Read errors before pass rates. An arm with errors measured fewer trials than it planned.
- A sign test p-value above 0.05 is not a difference. Add repeats rather than tasks the arm was tuned
  on.
- Keep a held-out set: tasks nobody looked at while changing the agent. `--tasks` takes a list file.
