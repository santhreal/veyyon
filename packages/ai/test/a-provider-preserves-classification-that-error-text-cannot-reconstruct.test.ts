/**
 * WHY: Error events reclassify their formatted text, so an omitted provider error id can
 * pass HTTP-status tests while losing classification recorded only on the thrown error.
 * Exercise the real provider catch and event-stream boundary for every failure flag.
 * This covers request-preparation failures, not provider-specific diagnostic suffixes
 * or network transport behavior. The marker bit alone is not a failure classification.
 */
import { describe, expect, it } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import * as AIError from "../src/error";
import { streamOllama } from "../src/providers/ollama";

const model = buildModel({
	id: "local-model",
	name: "Local model",
	api: "ollama-chat",
	provider: "ollama",
	baseUrl: "http://127.0.0.1:11434",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
});
const flags = Object.entries(AIError.Flag);
const cases = flags.filter(([name]) => name !== "Class");

describe("provider error classification survives formatting", () => {
	it("excludes only the classification marker from failure cases", () => {
		expect(flags.filter(([name]) => !cases.some(([included]) => included === name)).map(([name]) => name)).toEqual([
			"Class",
		]);
	});

	it.each(cases)(
		"retains %s classification from request preparation",
		async (_name, flag) => {
			const failure = AIError.attach(new Error("Request preparation failed"), AIError.create(flag));
			let requests = 0;
			const result = await streamOllama(
				model,
				{ messages: [] },
				{
					apiKey: "test-key",
					onPayload: () => {
						throw failure;
					},
					fetch: async () => {
						requests++;
						return new Response('{"done":true}\n');
					},
				},
			).result();
			expect(requests).toBe(0);
			expect(result.stopReason).toBe("error");
			expect(AIError.is(result.errorId, flag)).toBe(true);
		},
		1000,
	);
});
