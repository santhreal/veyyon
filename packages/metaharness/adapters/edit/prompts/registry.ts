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

export const EDIT_BENCHMARK_PROMPTS = editBenchmarkPrompts.prompts;

