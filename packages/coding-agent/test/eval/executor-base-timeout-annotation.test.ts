import { describe, expect, it } from "bun:test";
import {
	formatKernelTimeoutAnnotation,
	formatTimeoutAnnotation,
	timeoutSeconds,
} from "@veyyon/coding-agent/eval/executor-base";

/**
 * These annotations are shared verbatim by every kernel executor (python, ruby, ...).
 * They were once byte-identical copies pasted into each executor; the copies drifted
 * risk and the return-type lie (`string | undefined` where a string was always produced)
 * are what this single-owner suite locks out. If a second copy reappears or the
 * whole-second/killed-kernel wording changes silently, these assertions fail.
 */
describe("eval executor-base timeout annotations (single owner)", () => {
	describe("timeoutSeconds", () => {
		it("floors a sub-second budget at 1 so a label never reads '0 seconds'", () => {
			expect(timeoutSeconds(1)).toBe(1);
			expect(timeoutSeconds(400)).toBe(1);
			expect(timeoutSeconds(0)).toBe(1);
		});

		it("rounds to the nearest whole second", () => {
			expect(timeoutSeconds(1499)).toBe(1);
			expect(timeoutSeconds(1500)).toBe(2);
			expect(timeoutSeconds(30_000)).toBe(30);
		});
	});

	describe("formatTimeoutAnnotation", () => {
		it("states the whole-second budget when the timeout is known", () => {
			expect(formatTimeoutAnnotation(30_000)).toBe("Command timed out after 30 seconds");
		});

		it("floors a sub-second budget into the label", () => {
			expect(formatTimeoutAnnotation(250)).toBe("Command timed out after 1 seconds");
		});

		it("returns a bare string (never undefined) when no budget is known", () => {
			const annotation = formatTimeoutAnnotation(undefined);
			expect(annotation).toBe("Command timed out");
			expect(typeof annotation).toBe("string");
		});
	});

	describe("formatKernelTimeoutAnnotation", () => {
		it("reports a killed, to-be-recreated kernel regardless of the budget", () => {
			const annotation = formatKernelTimeoutAnnotation(30_000, true);
			expect(annotation).toContain("kernel has been killed and will be recreated");
			expect(annotation).not.toContain("30s");
		});

		it("names the whole-second budget for an interrupted-but-alive kernel", () => {
			const annotation = formatKernelTimeoutAnnotation(30_000, false);
			expect(annotation).toContain("timed out after 30s");
			expect(annotation).toContain("kernel interrupted but remains running");
		});

		it("falls back to 'the configured timeout' when the budget is unknown", () => {
			const annotation = formatKernelTimeoutAnnotation(undefined, false);
			expect(annotation).toContain("timed out after the configured timeout");
		});
	});
});
