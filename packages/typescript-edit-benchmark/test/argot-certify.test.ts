/**
 * The Argot certification core — the deterministic verdict engine of the adoption
 * benchmark. These tests exist because a green benchmark must MEAN "argot works":
 * a real model adopted handles and netted a token saving, losslessly, without
 * losing task success. If the verdict math were wrong, the live bench could pass
 * on a transcript that leaked raw shorthand or spent more tokens. Each of the four
 * truths therefore has a dedicated failing case here, plus the all-pass case, so
 * the assertion the live suite relies on is itself proven.
 */
import { describe, expect, test } from "bun:test";
import { parseDict } from "argot";
import {
	type ArgotRunMeasurement,
	assembleRunMeasurement,
	assertArgotCertified,
	certifyArgot,
	collectEmittedStrings,
	evaluateCertification,
	measureTranscript,
} from "../src/argot-certify";

const VOCAB = parseDict(
	`version = 1
[handles]
dbconn = "packages/server/src/database/connection.ts"
svc = "the checkout service"
`,
	"AGENTS.dict",
);

describe("collectEmittedStrings", () => {
	test("pulls text, tool-call arguments, and intent from assistant turns only", () => {
		const messages = [
			{ role: "user", content: "leave §dbconn in my raw message" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "I will open §dbconn" },
					{ type: "thinking", text: "ignore me §svc" },
					{ type: "toolCall", name: "edit", arguments: { path: "§dbconn" }, intent: "touch §svc" },
				],
			},
			{ role: "toolResult", content: [{ type: "text", text: "§svc here is raw" }] },
		];
		const emitted = collectEmittedStrings(messages);
		// User + toolResult skipped; thinking part skipped; text + args + intent kept.
		expect(emitted).toEqual(["I will open §dbconn", JSON.stringify({ path: "§dbconn" }), "touch §svc"]);
	});

	test("skips assistant messages whose content is not an array", () => {
		const emitted = collectEmittedStrings([{ role: "assistant", content: "plain string content" }]);
		expect(emitted).toEqual([]);
	});
});

describe("measureTranscript", () => {
	test("sums adoption and distinct handles, and counts leaks, across strings", () => {
		const m = measureTranscript(VOCAB, ["open §dbconn", "restart §svc and §svc", "hallucinated §nope"]);
		expect(m.handleEmissions).toBe(3); // dbconn + svc + svc
		expect(m.distinctHandles).toBe(2); // dbconn, svc
		expect(m.unknownSigils).toBe(1); // §nope
	});

	test("an argot-off transcript (no sigils) measures as zero adoption and zero leaks", () => {
		const m = measureTranscript(VOCAB, ["open packages/server/src/database/connection.ts"]);
		expect(m).toEqual({ handleEmissions: 0, distinctHandles: 0, unknownSigils: 0 });
	});
});

function run(
	taskId: string,
	argotEnabled: boolean,
	passed: boolean,
	outputTokens: number,
	transcript = { handleEmissions: 0, distinctHandles: 0, unknownSigils: 0 },
): ArgotRunMeasurement {
	return { taskId, argotEnabled, passed, outputTokens, transcript };
}

describe("assembleRunMeasurement", () => {
	test("builds a run from a transcript, measuring adoption against the vocab", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "opening §dbconn and §svc" }] },
			{ role: "user", content: "ignored raw §dbconn" },
		];
		const m = assembleRunMeasurement({
			taskId: "t1",
			argotEnabled: true,
			passed: true,
			outputTokens: 42,
			vocab: VOCAB,
			messages,
		});
		expect(m).toEqual({
			taskId: "t1",
			argotEnabled: true,
			passed: true,
			outputTokens: 42,
			transcript: { handleEmissions: 2, distinctHandles: 2, unknownSigils: 0 },
		});
	});

	test("an argot-off run over the same vocab reports zero adoption", () => {
		const messages = [{ role: "assistant", content: [{ type: "text", text: "no shorthand at all here" }] }];
		const m = assembleRunMeasurement({
			taskId: "t2",
			argotEnabled: false,
			passed: false,
			outputTokens: 99,
			vocab: VOCAB,
			messages,
		});
		expect(m.transcript).toEqual({ handleEmissions: 0, distinctHandles: 0, unknownSigils: 0 });
		expect(m.passed).toBe(false);
	});
});

describe("certifyArgot pairing", () => {
	test("counts only tasks present in both on and off sets", () => {
		const on = [run("a", true, true, 100), run("b", true, true, 100), run("only-on", true, true, 999)];
		const off = [run("a", false, true, 150), run("b", false, true, 150), run("only-off", false, true, 999)];
		const cert = certifyArgot(on, off);
		expect(cert.pairedTasks).toBe(2); // a, b (not only-on / only-off)
		expect(cert.onOutputTokens).toBe(200);
		expect(cert.offOutputTokens).toBe(300);
		expect(cert.netOutputTokenDelta).toBe(-100);
	});

	test("sums repeated runs of the same task and setting", () => {
		const on = [run("a", true, true, 100), run("a", true, false, 120)];
		const off = [run("a", false, true, 200)];
		const cert = certifyArgot(on, off);
		expect(cert.pairedTasks).toBe(1);
		expect(cert.onPassCount).toBe(1);
		expect(cert.onOutputTokens).toBe(220);
	});
});

describe("evaluateCertification — the four truths", () => {
	const pass = () => ({
		pairedTasks: 3,
		onPassCount: 3,
		offPassCount: 3,
		totalHandleEmissions: 12,
		totalUnknownSigils: 0,
		onOutputTokens: 800,
		offOutputTokens: 1000,
		netOutputTokenDelta: -200,
	});

	test("certified: all four truths hold -> no failures", () => {
		expect(evaluateCertification(pass())).toEqual([]);
	});

	test("fails adoption when the model emitted zero handles", () => {
		const failures = evaluateCertification({ ...pass(), totalHandleEmissions: 0 });
		expect(failures.map(f => f.truth)).toEqual(["adoption"]);
	});

	test("fails net-tokens when argot on did not reduce output tokens", () => {
		const failures = evaluateCertification({
			...pass(),
			onOutputTokens: 1100,
			offOutputTokens: 1000,
			netOutputTokenDelta: 100,
		});
		expect(failures.map(f => f.truth)).toEqual(["net-tokens"]);
	});

	test("fails pass-parity when argot on regressed task success", () => {
		const failures = evaluateCertification({ ...pass(), onPassCount: 2, offPassCount: 3 });
		expect(failures.map(f => f.truth)).toEqual(["pass-parity"]);
	});

	test("fails losslessness when a raw sigil leaked unexpanded", () => {
		const failures = evaluateCertification({ ...pass(), totalUnknownSigils: 1 });
		expect(failures.map(f => f.truth)).toEqual(["losslessness"]);
	});

	test("reports every unmet truth at once, not just the first", () => {
		const failures = evaluateCertification({
			pairedTasks: 2,
			onPassCount: 1,
			offPassCount: 2,
			totalHandleEmissions: 0,
			totalUnknownSigils: 3,
			onOutputTokens: 1200,
			offOutputTokens: 1000,
			netOutputTokenDelta: 200,
		});
		expect(new Set(failures.map(f => f.truth))).toEqual(
			new Set(["adoption", "net-tokens", "pass-parity", "losslessness"]),
		);
	});

	test("fails when there are no paired runs at all", () => {
		const failures = evaluateCertification({
			pairedTasks: 0,
			onPassCount: 0,
			offPassCount: 0,
			totalHandleEmissions: 0,
			totalUnknownSigils: 0,
			onOutputTokens: 0,
			offOutputTokens: 0,
			netOutputTokenDelta: 0,
		});
		expect(failures).toHaveLength(1);
		expect(failures[0]!.truth).toBe("adoption");
	});
});

describe("assertArgotCertified", () => {
	test("returns silently when certified", () => {
		const on = [run("a", true, true, 80, { handleEmissions: 4, distinctHandles: 2, unknownSigils: 0 })];
		const off = [run("a", false, true, 100)];
		expect(() => assertArgotCertified(certifyArgot(on, off))).not.toThrow();
	});

	test("throws a message naming every unmet truth when the feature is broken", () => {
		// The RED state today: gate fires but the model adopts nothing and saves nothing.
		const on = [run("a", true, true, 110, { handleEmissions: 0, distinctHandles: 0, unknownSigils: 0 })];
		const off = [run("a", false, true, 100)];
		let message = "";
		try {
			assertArgotCertified(certifyArgot(on, off));
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("Argot certification FAILED");
		expect(message).toContain("[adoption]");
		expect(message).toContain("[net-tokens]");
	});
});
