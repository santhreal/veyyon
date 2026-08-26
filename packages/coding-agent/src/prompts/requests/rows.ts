/**
 * The `requests/` prompt rows. Each directory owns its rows so importing one prompt doesn't reach all
 * 163 (the old single-module layout made `tools/read.ts` pay 167 modules). Invariant: every `.md` is
 * imported by exactly one row module, aggregated by `registry.ts`, nothing else imports a `.md`.
 * `test/core/prompt-registry-coverage.test.ts` pins this. DO NOT re-declare a row another module holds.
 */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

import requestsCiGreen from "./ci-green.md" with { type: "text" };
import requestsReview from "./review.md" with { type: "text" };
import requestsReviewCustom from "./review-custom.md" with { type: "text" };
import requestsReviewHeadless from "./review-headless.md" with { type: "text" };

/** Every prompt under `src/prompts/requests/`, keyed by its id (the path under `src/prompts/`). */
export const requestsPrompts = definePromptRows({
	"requests/ci-green": { text: requestsCiGreen, purpose: "drives a session to keep working until branch CI is green" },
	"requests/review": { text: requestsReview, purpose: "a code review over a concrete changed-file set" },
	"requests/review-custom": {
		text: requestsReviewCustom,
		purpose: "a code review run under caller-supplied instructions",
	},
	"requests/review-headless": {
		text: requestsReviewHeadless,
		purpose: "a code review run with no interactive operator",
	},
} satisfies Record<string, PromptEntry>);
