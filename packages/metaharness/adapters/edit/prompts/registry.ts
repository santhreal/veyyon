/**
 * Every prompt the edit-benchmark adapter sends a model, owned in ONE place.
 *
 * The same contract the product's registries state, at this adapter's boundary: the
 * import IS the registration, the id is the path under this `prompts/` directory
 * without its extension, and nothing outside this file imports one of these `.md`
 * files. `prompt-registry-coverage` pins both directions.
 *
 * WHY A BENCHMARK ADAPTER GETS ONE TOO. These three prompts decide what every scored
 * run is asked to do, so a silent change to one moves every number the harness
 * reports while the code that produced them is untouched. They were imported by
 * relative path from `runner.ts` and appeared in no list, which is how a benchmark
 * ends up unable to say what it asked the model.
 */
import { definePromptRegistry, type PromptEntry } from "@veyyon/utils";
import benchmarkRetry from "./benchmark-retry.md" with { type: "text" };
import benchmarkSystem from "./benchmark-system.md" with { type: "text" };
import benchmarkTask from "./benchmark-task.md" with { type: "text" };

export type { PromptEntry };

export const editBenchmarkPrompts = definePromptRegistry("packages/metaharness/adapters/edit/prompts", {
	"benchmark-retry": {
		text: benchmarkRetry,
		purpose: "re-asks a failed benchmark edit with the same task and added context",
	},
	"benchmark-system": {
		text: benchmarkSystem,
		purpose: "the system prompt a scored edit-benchmark run works under",
	},
	"benchmark-task": {
		text: benchmarkTask,
		purpose: "the edit task itself, with whatever guided context the case supplies",
	},
});

/** Every prompt this adapter sends, by id. */
export const EDIT_BENCHMARK_PROMPTS = editBenchmarkPrompts.prompts;

/**
 * Nothing else is exported. `editBenchmarkPrompts` carries the id list and the lookups, and
 * `require` is the one that matters here: a benchmark is the worst place for a prompt to
 * resolve to nothing, because an empty system prompt still produces a run and still
 * produces a score, and the score is then attributed to the model rather than to the
 * missing brief.
 */
