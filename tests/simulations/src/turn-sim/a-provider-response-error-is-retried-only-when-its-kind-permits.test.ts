/**
 * A provider response error is retried if and only if its kind declares it transient.
 *
 * WHY THIS FILE EXISTS. `provider-error-taxonomy.test.ts` tests HTTP status codes
 * and wire error strings, while `stream-death-mid-batch.test.ts` tested a single
 * hardcoded incomplete stream message. The classifier source of truth for all
 * non-HTTP provider stream errors is `PROVIDER_RESPONSE_RETRYABLE` in `@veyyon/ai`.
 *
 * This suite dynamically derives the test matrix from `PROVIDER_RESPONSE_RETRYABLE`
 * so adding a new `ProviderResponseErrorKind` immediately exercises turn retry
 * behaviour across all tool-batch stream deaths and fails if unhandled.
 */
import { describe, expect, it } from "bun:test";
import * as AIError from "@veyyon/ai/error";
import { TOOL } from "@veyyon/coding-agent/tools/core/builtin-names";
import { createSimulation, simTool } from "./harness";

const PLACEHOLDER_MARKER = "was not executed because the provider stream ended";

async function runKindSimulation(options: { kind: AIError.ProviderResponseErrorKind }): Promise<{
	ran: string[];
	requests: number;
	toolTexts: string[];
}> {
	const ran: string[] = [];
	const error = new AIError.ProviderResponseError(`Stream error for kind ${options.kind}`, {
		provider: "openai",
		kind: options.kind,
	});
	const errorId = AIError.classify(error);

	const sim = await createSimulation({
		settings: { "retry.maxRetries": 1, "retry.baseDelayMs": 1, "retry.maxDelayMs": 1000 },
		tools: [
			simTool(TOOL.bash, async () => {
				ran.push("bash");
				return { content: [{ type: "text", text: "bash ran" }] };
			}),
			simTool(TOOL.read, async () => {
				ran.push("read");
				return { content: [{ type: "text", text: "read ran" }] };
			}),
		],
		script: turn => {
			if (turn.call === 1) {
				turn.toolCall(TOOL.bash, { command: "echo one" }, "call-a");
				turn.toolCall(TOOL.read, { path: "README.md" }, "call-b");
				turn.fail(error.message, errorId);
				return;
			}
			if (turn.call === 2 && ran.length === 0) {
				turn.toolCall(TOOL.bash, { command: "echo one" }, "call-a");
				turn.toolCall(TOOL.read, { path: "README.md" }, "call-b");
				turn.finish();
				return;
			}
			turn.text("both done");
			turn.finish();
		},
	});

	try {
		await sim.session.prompt("execute tool batch");
		const toolTexts: string[] = [];
		for (const event of sim.eventsOfType("tool_execution_end")) {
			const content = event.result.content ?? [];
			for (const block of content) {
				if (block.type === "text") toolTexts.push(block.text);
			}
		}
		return {
			ran,
			requests: sim.sessionRequests().length,
			toolTexts,
		};
	} finally {
		await sim.dispose();
	}
}

describe("error taxonomy derivation for ProviderResponseErrorKind", () => {
	it("derives retry decisions for every ProviderResponseErrorKind from the classifier source", async () => {
		const kinds = Object.keys(AIError.PROVIDER_RESPONSE_RETRYABLE) as AIError.ProviderResponseErrorKind[];
		expect(kinds.length).toBeGreaterThanOrEqual(4);
		expect(kinds).toContain("incomplete-stream");
		expect(kinds).toContain("empty-body");
		expect(kinds).toContain("envelope");
		expect(kinds).toContain("output");

		for (const kind of kinds) {
			const expectedRetryable = AIError.PROVIDER_RESPONSE_RETRYABLE[kind];
			const error = new AIError.ProviderResponseError(`Stream error for kind ${kind}`, {
				provider: "openai",
				kind,
			});
			const errorId = AIError.classify(error);
			expect(AIError.retriable(errorId)).toBe(expectedRetryable);

			const result = await runKindSimulation({ kind });

			if (expectedRetryable) {
				expect(result.ran).toEqual(["bash", "read"]);
				expect(result.requests).toBe(3);
			} else {
				expect(result.ran).toEqual([]);
				expect(result.requests).toBe(1);
				expect(result.toolTexts.filter(t => t.includes(PLACEHOLDER_MARKER))).toHaveLength(2);
			}
		}
	});
});
