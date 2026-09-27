# Writing a kit suite

The kit (`engine/kit/`) turns a catalog of tasks into a suite. A task starts its own services for
one trial, tells the agent what to do, and is graded by checks over what those services recorded and
the agent's final answer. The browser and MiniWoB++ suites are kit suites.

## A task

```ts
import { answerHasNumber } from "../../engine/kit/checks";
import { kitTask } from "../../engine/kit/catalog";
import { FormClient } from "../../engine/kit/form-client";
import { Seeded } from "../../engine/kit/seeded";
import { hostSite, text } from "../../engine/kit/web-host";

interface PressState {
	readonly presses: number;
	readonly expected: number;
}

export const pressTask = kitTask<PressState>({
	id: "press-n-times",
	title: "Press a button a stated number of times",
	capabilities: ["forms"],
	difficulty: "easy",
	async start({ seed }) {
		const expected = new Seeded(seed).int(2, 5);
		let presses = 0;
		const site = await hostSite(request => {
			if (request.method === "POST" && request.url.pathname === "/press") presses++;
			return text(String(presses));
		});
		return {
			instruction: `Press ${expected} times at ${site.origin}/press, then say how many.`,
			async solve() {
				const client = new FormClient(site.origin);
				for (let i = 0; i < expected; i++) await client.post("/press");
				return `Pressed ${expected} times.`;
			},
			async finish() {
				await site.close();
				return { presses, expected };
			},
		};
	},
	checks: [
		{ id: "pressed", description: "pressed the stated number of times", pass: state => state.presses === state.expected },
		{ id: "reported", description: "reported the count", pass: (state, answer) => answerHasNumber(answer, state.expected) },
	],
});
```

- `start` receives a `seed`, the agent's `workspace` and the `trialDir`. It starts what the task
  needs and returns the instruction. The seed is the task id and the repeat, never the arm, so every
  arm of a comparison meets the same data and every repeat meets new data.
- `finish` stops the services and returns the state the checks read. The suite writes it to
  `state.json` in the trial directory, which the agent cannot read. It must survive
  `JSON.stringify`; carry what the checks compare against in it (an `expected` field), so grading
  reads the file alone and a run can be graded again after a check is fixed.
- `checks` are named and small. A trial passes (`reward: 1`) when every check passes; the fraction
  that pass is its `partial`. A check that throws fails.
- `solve` performs the task through the services' own endpoints and returns the answer a correct
  agent gives. It is required, and only tests call it.

## The pieces

| Module | Holds |
|---|---|
| `engine/kit/catalog.ts` | `kitTask`, the task and trial types, `catalogProblems` |
| `engine/kit/suite.ts` | `defineSuite`, `trialSeed`, the `state.json` name |
| `engine/kit/checks.ts` | `gradeChecks`, `answerHasText`, `answerHasNumber`, `normalizeText` |
| `engine/kit/web-host.ts` | `hostSite` (an HTTP server on 127.0.0.1 per trial), responses, forms, cookies |
| `engine/kit/form-client.ts` | `FormClient`: form posts with cookies and redirects, for `solve` |
| `engine/kit/seeded.ts` | `Seeded`, a deterministic generator for task data |
| `engine/kit/browser-host.ts` | the browser tool's settings and the Chromium a trial launches |
| `engine/kit/report.ts` | the run report: pass rates, capability and difficulty breakdowns, budget curves, paired arms |

## A suite

```ts
export default defineSuite({
	id: "presses",
	version: "1.0.0",
	displayName: "Presses",
	description: "Pressing buttons.",
	sourceDir: import.meta.dirname,
	capabilities: { forms: "filling and submitting forms" },
	tasks: [pressTask],
	tools: ["browser"],
	settings: BROWSER_TOOL_SETTINGS,
	defaultTimeBudgetSec: 300,
	preflight: chromiumPreflight,
	hostEnvironment: browserHostEnvironment,
});
```

`sourceDir` is hashed into the run's provenance, so two runs of different task code never compare
as one suite version. `capabilities` is the vocabulary a task names; the preflight refuses a task
that names another, reuses an id, or has no checks. `hostEnvironment` supplies what every trial's
tools need from this host (the Chromium executable, and read access to its directory).

## Testing a task list

`test/suites/browser/task-sweep.ts` runs every task over three seeds: the solution must pass every
check, and a trial in which nothing happens must fail. A task that no agent can pass, or that passes
when nothing is done, fails the sweep. Call `sweepTasks(tasks)` from the suite's test file.

The sweep proves the grading, not the pages. Perform at least two tasks of an application through
real pages in Chromium before calling it done, and run the suite once with a real model.
