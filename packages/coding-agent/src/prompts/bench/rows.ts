/** The `bench/` prompt rows: fixed generation requests used for measurement. and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }` */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

import benchBalance from "./balance.md" with { type: "text" };
import benchThroughput from "./throughput.md" with { type: "text" };

/** Every prompt under `src/prompts/bench/`, keyed by its id (the path under `src/prompts/`). */
export const benchPrompts = definePromptRows({
	"bench/balance": {
		text: benchBalance,
		purpose: "a fixed short generation request used to warm and compare provider balance",
	},
	"bench/throughput": {
		text: benchThroughput,
		purpose: "a fixed long-form generation request used to benchmark throughput",
	},
} satisfies Record<string, PromptEntry>);
