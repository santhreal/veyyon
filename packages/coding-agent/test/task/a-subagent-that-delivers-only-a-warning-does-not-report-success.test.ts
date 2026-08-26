/**
 * WHY: `finalizeSubprocessOutput` could return `exitCode: 0` while the entire delivered payload was
 * a `SYSTEM WARNING:` sentence. A subagent that called `yield` with unusable data took the null-yield
 * arm, which prepended {@link SUBAGENT_WARNING_NULL_YIELD} to `rawOutput` and changed nothing else,
 * so the parent read a success whose result text was the warning. The missing-yield arm — the milder
 * failure, where the child never yielded at all — already set a non-zero exit and a stderr, so the
 * worse failure reported better than the lesser one.
 *
 * The class this closes is "a delivered payload that is only a system warning is reported as
 * success", across BOTH warning sentinels and the full schema/raw-output matrix, rather than the one
 * reported input. The tolerated corner is kept explicit: with no output schema and real prose in
 * `rawOutput`, the prose IS the answer and the run stays successful.
 *
 * What this does NOT catch: whether `resolveRunVerdict` downstream honours the exit code, whether
 * `assembleYieldResult` correctly decides that data is missing in the first place, and any warning
 * surfaced by a path other than `finalizeSubprocessOutput`.
 */
import { describe, expect, it } from "bun:test";
import * as executor from "@veyyon/coding-agent/task/executor";
import {
	finalizeSubprocessOutput,
	SUBAGENT_WARNING_MISSING_YIELD,
	SUBAGENT_WARNING_NULL_YIELD,
} from "@veyyon/coding-agent/task/executor";

/** A yield that reports success but carries no data at all — the null-yield case. */
const NULL_YIELD = [{ status: "success" as const }];
/** No yield ever arrived — the missing-yield case. */
const NO_YIELD = undefined;

const SCHEMA = { properties: { ok: { type: "boolean" } }, required: ["ok"] };

function finalize(options: {
	rawOutput: string;
	yieldItems: typeof NULL_YIELD | typeof NO_YIELD;
	outputSchema: unknown;
	stderr?: string;
	exitCode?: number;
}) {
	return finalizeSubprocessOutput({
		rawOutput: options.rawOutput,
		exitCode: options.exitCode ?? 0,
		stderr: options.stderr ?? "",
		doneAborted: false,
		signalAborted: false,
		yieldItems: options.yieldItems,
		outputSchema: options.outputSchema,
	});
}

describe("a subagent that delivers only a warning does not report success", () => {
	// Derived from source at run time so a third sentinel turns this red until someone decides
	// which arm it belongs to, rather than slipping past a hardcoded pair.
	it("covers every exported subagent warning sentinel", () => {
		const sentinels = Object.keys(executor)
			.filter(key => key.startsWith("SUBAGENT_WARNING_"))
			.sort();
		expect(sentinels).toEqual(["SUBAGENT_WARNING_MISSING_YIELD", "SUBAGENT_WARNING_NULL_YIELD"]);
	});

	describe("a null yield", () => {
		it("fails when a schema was demanded and only prose came back", () => {
			const result = finalize({ rawOutput: "partial output", yieldItems: NULL_YIELD, outputSchema: SCHEMA });

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toBe(SUBAGENT_WARNING_NULL_YIELD);
			expect(result.hasYield).toBe(true);
		});

		it("fails when a schema was demanded and nothing came back", () => {
			const result = finalize({ rawOutput: "", yieldItems: NULL_YIELD, outputSchema: SCHEMA });

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toBe(SUBAGENT_WARNING_NULL_YIELD);
			expect(result.rawOutput).toBe(SUBAGENT_WARNING_NULL_YIELD);
		});

		it("fails when nothing at all was delivered, even with no schema to satisfy", () => {
			const result = finalize({ rawOutput: "", yieldItems: NULL_YIELD, outputSchema: undefined });

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toBe(SUBAGENT_WARNING_NULL_YIELD);
			// The whole payload is the warning; there is no answer behind it.
			expect(result.rawOutput).toBe(SUBAGENT_WARNING_NULL_YIELD);
		});

		it("stays successful when no schema was demanded and real prose came back", () => {
			const result = finalize({ rawOutput: "plain text notes", yieldItems: NULL_YIELD, outputSchema: undefined });

			// Deliberate: the prose is the deliverable, the warning only annotates it.
			expect(result.exitCode).toBe(0);
			expect(result.rawOutput).toBe(`${SUBAGENT_WARNING_NULL_YIELD}\n\nplain text notes`);
		});

		it("treats whitespace-only output as nothing delivered", () => {
			const result = finalize({ rawOutput: "   \n\t ", yieldItems: NULL_YIELD, outputSchema: undefined });

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toBe(SUBAGENT_WARNING_NULL_YIELD);
		});

		it("keeps an earlier real failure message instead of overwriting it with the warning", () => {
			const result = finalize({
				rawOutput: "",
				yieldItems: NULL_YIELD,
				outputSchema: SCHEMA,
				exitCode: 1,
				stderr: "Provider returned error finish_reason",
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toBe("Provider returned error finish_reason");
		});
	});

	describe("a missing yield", () => {
		it("fails when a schema was demanded and nothing came back", () => {
			const result = finalize({ rawOutput: "", yieldItems: NO_YIELD, outputSchema: SCHEMA });

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toBe(SUBAGENT_WARNING_MISSING_YIELD);
			expect(result.hasYield).toBe(false);
		});

		it("fails when a schema was demanded and only prose came back", () => {
			const result = finalize({ rawOutput: "partial output", yieldItems: NO_YIELD, outputSchema: SCHEMA });

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toBe(SUBAGENT_WARNING_MISSING_YIELD);
		});

		it("fails when nothing at all was delivered, even with no schema to satisfy", () => {
			const result = finalize({ rawOutput: "", yieldItems: NO_YIELD, outputSchema: undefined });

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toBe(SUBAGENT_WARNING_MISSING_YIELD);
		});

		it("stays successful when no schema was demanded and real prose came back", () => {
			const result = finalize({ rawOutput: "plain text notes", yieldItems: NO_YIELD, outputSchema: undefined });

			expect(result.exitCode).toBe(0);
			expect(result.rawOutput).toBe("plain text notes");
		});
	});

	// The two arms disagreed on exactly this, which is how the defect survived. Pin the agreement so
	// a future edit to one arm cannot silently re-open the gap in the other.
	it("reports the same verdict from both arms for the same delivery shape", () => {
		const shapes = [
			{ rawOutput: "", outputSchema: SCHEMA },
			{ rawOutput: "partial output", outputSchema: SCHEMA },
			{ rawOutput: "", outputSchema: undefined },
			{ rawOutput: "plain text notes", outputSchema: undefined },
		];

		for (const shape of shapes) {
			const nullYield = finalize({ ...shape, yieldItems: NULL_YIELD });
			const missingYield = finalize({ ...shape, yieldItems: NO_YIELD });

			expect({
				shape,
				nullYieldFailed: nullYield.exitCode !== 0,
			}).toEqual({
				shape,
				nullYieldFailed: missingYield.exitCode !== 0,
			});
		}
	});
});
