/**
 * The `bench/` prompt rows. Each directory owns its rows so importing one prompt doesn't reach all
 * 163 (the old single-module layout made `tools/read.ts` pay 167 modules). Invariant: every `.md` is
 * imported by exactly one row module, aggregated by `registry.ts`, nothing else imports a `.md`.
 * `test/core/prompt-registry-coverage.test.ts` pins this. DO NOT re-declare a row another module holds.
 */

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
