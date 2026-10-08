/**
 * A tool-call or assistant-turn metrics record is re-projected at the live instrumentation level
 * before it is written to the session file. The projection must hold exactly the fields a capture
 * at the lower of the record's level and the live level would hold: no field a tier permits is
 * dropped, no field above it leaks, and no key is written with an `undefined` value.
 *
 * The oracle is the capture function itself at the lower level, so the suite needs no copy of the
 * tier table. It sweeps every level in `INSTRUMENTATION_LEVELS` plus an unknown string and
 * `undefined`, as the record's declared level and as the live level, over the full input and over
 * every input with one optional field removed (enumerated from the input object at run time).
 *
 * Not caught: a field the capture never produces from these inputs, and the persisted key order.
 * A new metrics field without a tier fails to compile at the `Record` tier tables in
 * `src/instrumentation.ts`.
 */
import { describe, expect, it } from "bun:test";
import {
	type AssistantTurnMetrics,
	type AssistantTurnMetricsInput,
	assistantTurnMetricsForPersistence,
	captureAssistantTurnMetrics,
	captureToolCallMetrics,
	INSTRUMENTATION_LEVELS,
	type InstrumentationLevel,
	instrumentationRank,
	SESSION_TELEMETRY_POLICY,
	type ToolCallMetrics,
	type ToolCallMetricsInput,
	toolCallMetricsForPersistence,
} from "@veyyon/ai";

// An unknown string reaches persistence from a malformed config or a record written by another build.
const UNKNOWN = "verbose" as InstrumentationLevel;
const DECLARED_LEVELS: readonly InstrumentationLevel[] = [...INSTRUMENTATION_LEVELS, UNKNOWN];
const LIVE_LEVELS: readonly (InstrumentationLevel | undefined)[] = [...DECLARED_LEVELS, undefined];
const CAPTURE_LEVELS = INSTRUMENTATION_LEVELS.filter(level => level !== "off");

function lower(a: InstrumentationLevel, b: InstrumentationLevel): InstrumentationLevel {
	return instrumentationRank(a) < instrumentationRank(b) ? a : b;
}

function liveLevelPersists(live: InstrumentationLevel | undefined, minimum: InstrumentationLevel): boolean {
	return (
		(live === "basic" || live === "rich" || live === "ultra") &&
		instrumentationRank(live) >= instrumentationRank(minimum)
	);
}

/** The full input, then one variant per optional field with that field removed. */
function variants<T extends object>(full: T, required: readonly (keyof T)[]): T[] {
	const optional = (Object.keys(full) as (keyof T)[]).filter(key => !required.includes(key));
	return [
		full,
		...optional.map(key => {
			const variant = { ...full };
			delete variant[key];
			return variant;
		}),
	];
}

function sweep<I extends { level: InstrumentationLevel }, M extends { level: InstrumentationLevel }>(
	inputs: readonly I[],
	minimum: InstrumentationLevel,
	capture: (input: I) => M | undefined,
	persist: (metrics: M, level: InstrumentationLevel | undefined) => M | undefined,
): number {
	let cases = 0;
	for (const input of inputs) {
		for (const captured of CAPTURE_LEVELS) {
			const record = capture({ ...input, level: captured });
			if (!record) throw new Error(`capture at ${captured} returned nothing`);
			for (const declared of DECLARED_LEVELS) {
				for (const live of LIVE_LEVELS) {
					const persisted = persist({ ...record, level: declared }, live);
					cases += 1;
					if (declared === "off" || !liveLevelPersists(live, minimum)) {
						expect(persisted).toBeUndefined();
						continue;
					}
					const label = lower(declared, live as InstrumentationLevel);
					const expected = capture({ ...input, level: lower(captured, label) });
					if (!expected) throw new Error(`capture at ${label} returned nothing`);
					expect(persisted).toStrictEqual({ ...expected, level: label });
				}
			}
		}
	}
	return cases;
}

const toolInput: ToolCallMetricsInput = {
	level: "ultra",
	startedAt: 1_000,
	endedAt: 1_250,
	queuedAt: 940,
	concurrency: "exclusive",
	batchId: "batch-1",
	batchIndex: 0,
	batchSize: 3,
	status: "ok",
	interruptible: false,
	signalAborted: true,
	useless: true,
	resultContent: [
		{ type: "text", text: "alpha beta" },
		{ type: "image", data: "AAAA", mimeType: "image/png" },
	],
	args: { path: "src/app.ts", limit: 10 },
	countTokens: text => text.length,
};

const turnInput: AssistantTurnMetricsInput = {
	level: "ultra",
	startedAt: 10_000,
	endedAt: 12_000,
	status: "ok",
	ttftMs: 500,
	usage: {
		input: 100,
		output: 300,
		cacheRead: 20,
		cacheWrite: 10,
		totalTokens: 430,
		reasoningTokens: 40,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	previousCacheReadTokens: 5_000,
	upstreamProvider: "upstream",
};

describe("a persisted metrics record", () => {
	it("holds exactly the tool-call fields the lower of its level and the live level permits", () => {
		const cases = sweep<ToolCallMetricsInput, ToolCallMetrics>(
			variants(toolInput, ["level", "startedAt", "endedAt", "status"]),
			SESSION_TELEMETRY_POLICY["tool-span"],
			captureToolCallMetrics,
			toolCallMetricsForPersistence,
		);
		expect(cases).toBeGreaterThan(0);
	});

	it("holds exactly the assistant-turn fields the lower of its level and the live level permits", () => {
		const cases = sweep<AssistantTurnMetricsInput, AssistantTurnMetrics>(
			variants(turnInput, ["level", "startedAt", "endedAt", "status"]),
			SESSION_TELEMETRY_POLICY["model-turn"],
			captureAssistantTurnMetrics,
			assistantTurnMetricsForPersistence,
		);
		expect(cases).toBeGreaterThan(0);
	});

	it("drops a tool-declared useless reason unless the call succeeded", () => {
		const record = captureToolCallMetrics({ ...toolInput, status: "ok" });
		if (!record) throw new Error("expected metrics");
		expect(toolCallMetricsForPersistence({ ...record, status: "error" }, "ultra")).not.toHaveProperty(
			"uselessReason",
		);
		expect(toolCallMetricsForPersistence(record, "basic")?.uselessReason).toBe("tool-declared");
	});
});

describe("a captured tool result weight", () => {
	const texts = ["ascii", "héllo", "日本語", "😀", "\ud800lone", "tail\udc00", ""];

	it("counts the UTF-8 bytes of every text block, a lone surrogate as its replacement character", () => {
		const encoder = new TextEncoder();
		for (const text of texts) {
			const metrics = captureToolCallMetrics({
				...toolInput,
				level: "rich",
				resultContent: [
					{ type: "text", text },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
					{ type: "text", text },
				],
			});
			expect(metrics?.resultBytes).toBe(2 * encoder.encode(text).length);
		}
	});

	it("counts the tokens of the text blocks joined by newlines, images excluded", () => {
		const seen: string[] = [];
		const metrics = captureToolCallMetrics({
			...toolInput,
			level: "rich",
			resultContent: [
				{ type: "text", text: "one" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
				{ type: "text", text: "two" },
			],
			countTokens: text => {
				seen.push(text);
				return 7;
			},
		});
		expect(seen).toEqual(["one\ntwo"]);
		expect(metrics?.resultTokens).toBe(7);
	});

	it("measures the serialized arguments in UTF-8 bytes", () => {
		const args = { path: "src/日本語.ts" };
		const metrics = captureToolCallMetrics({ ...toolInput, args });
		expect(metrics?.argsBytes).toBe(new TextEncoder().encode(JSON.stringify(args)).length);
	});
});
