# Benches, measurements and tools

Programs are members that run for their output rather than as suites. Each is `<dir>/<id>.ts` or
`<dir>/<id>/main.ts`, runs its work under `import.meta.main`, and reads its own flags through
`engine/plan/flag-grammar.ts`.

## Benches

`evals bench <id>` runs one. A bench measures one mechanism against a fixed workload.

- `browser-fill`: `tab.fill` in headless Chromium at 16, 256 and 4,096 characters, counting a fill
  correct only when the field holds the value.
- `edit-prompt`: the edit tool's description against the edit fixtures with a real model: tasks
  passed and turns spent, for a before and an after description.
- `goal-budget-context`: the bytes the goal tool's description and schema add to a request.
- `search`: the search tool over every registered corpus, case suite and arm; whether the arms agree
  and whether each finds the declared answer. It spends no provider quota.

## Measurements

`evals measure <id>` runs one. A measurement reads recorded sessions and reports what a change could
save before anyone builds it.

- `prefix-composition`: prompt categories by token, cache hit rates, prefix mass, and the cost of a
  cache invalidation.
- `online-codec-ceiling`: the savings an append-only online dictionary codec could reach.
- `context-encode-ceiling`: the cost encoding the context (tool results above all) would save on a
  real session.
- `retype-likelihood`: how often dictionary candidates appear in agent output against how often the
  corpus predicts.
- `channel-split`: which channel an agent emits its line structure into: tool-call arguments or
  plain messages.

## Tools

`evals tool <id>` runs one.

- `bench-report`: writes a run's benchmark results into a feature document's results block.
- `generate-dicts`: generates argot dictionaries for DeepSWE task repositories, for inspection.
- `trace-report`: a narrative report of one run trace, from the manager server's normalized trace.
