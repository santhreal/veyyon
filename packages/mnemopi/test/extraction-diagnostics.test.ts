import { describe, expect, it } from "bun:test";
import {
	ExtractionDiagnostics,
	getDiagnostics,
	resetExtractionStats,
	safeForLog,
} from "@veyyon/mnemopi/core/extraction/diagnostics";

describe("safeForLog", () => {
	it("renders null and undefined as an empty string", () => {
		expect(safeForLog(null)).toBe("");
		expect(safeForLog(undefined)).toBe("");
	});

	it("formats an Error as 'name: message'", () => {
		expect(safeForLog(new TypeError("bad input"))).toBe("TypeError: bad input");
	});

	it("stringifies non-Error values", () => {
		expect(safeForLog(42)).toBe("42");
		expect(safeForLog("plain")).toBe("plain");
	});

	it("replaces control characters (NUL, ESC, DEL) with a space but keeps printable text", () => {
		expect(safeForLog("a\u0000b\u001bc\u007fd")).toBe("a b c d");
		expect(safeForLog("tab\tafter")).toBe("tab after");
	});

	it("caps the output at 200 characters", () => {
		expect(safeForLog("x".repeat(500))).toHaveLength(200);
	});
});

describe("ExtractionDiagnostics tier accounting", () => {
	it("rejects an unknown tier on every record method", () => {
		const diag = new ExtractionDiagnostics();
		expect(() => diag.recordAttempt("gpu" as never)).toThrow("unknown extraction tier");
		expect(() => diag.recordSuccess("gpu" as never)).toThrow("unknown extraction tier");
		expect(() => diag.recordNoOutput("gpu" as never)).toThrow("unknown extraction tier");
		expect(() => diag.recordFailure("gpu" as never)).toThrow("unknown extraction tier");
	});

	it("counts attempts, successes, and no-output against the right tier", () => {
		const diag = new ExtractionDiagnostics();
		diag.recordAttempt("host");
		diag.recordSuccess("host");
		diag.recordNoOutput("host");
		diag.recordNoOutput("remote");
		const tiers = diag.snapshot().by_tier;
		expect(tiers.host).toMatchObject({ attempts: 1, successes: 1, no_output: 1 });
		expect(tiers.remote.no_output).toBe(1);
		expect(tiers.local).toMatchObject({ attempts: 0, successes: 0, no_output: 0, failures: 0 });
	});
});

describe("ExtractionDiagnostics failure samples", () => {
	it("captures an Error's name and message", () => {
		const diag = new ExtractionDiagnostics();
		diag.recordFailure("local", new RangeError("out of range"));
		const [sample] = diag.snapshot().by_tier.local.error_samples;
		expect(sample?.type).toBe("RangeError");
		expect(sample?.msg).toBe("RangeError: out of range");
		expect(sample?.reason).toBeUndefined();
	});

	it("records a non-Error exception by its typeof and string form", () => {
		const diag = new ExtractionDiagnostics();
		diag.recordFailure("local", "raw failure");
		const [sample] = diag.snapshot().by_tier.local.error_samples;
		expect(sample?.type).toBe("string");
		expect(sample?.msg).toBe("raw failure");
	});

	it("falls back to the reason when no exception is given", () => {
		const diag = new ExtractionDiagnostics();
		diag.recordFailure("cloud", undefined, "rate limited");
		const [sample] = diag.snapshot().by_tier.cloud.error_samples;
		expect(sample?.type).toBe("reason");
		expect(sample?.msg).toBe("rate limited");
		expect(sample?.reason).toBe("rate limited");
	});

	it("marks a failure with neither exception nor reason as unspecified", () => {
		const diag = new ExtractionDiagnostics();
		diag.recordFailure("wrapper");
		const [sample] = diag.snapshot().by_tier.wrapper.error_samples;
		expect(sample?.type).toBe("unspecified");
		expect(sample?.msg).toBe("");
	});

	it("keeps the reason alongside an exception-derived type when both are given", () => {
		const diag = new ExtractionDiagnostics();
		diag.recordFailure("remote", new Error("boom"), "downstream");
		const [sample] = diag.snapshot().by_tier.remote.error_samples;
		expect(sample?.type).toBe("Error");
		expect(sample?.reason).toBe("downstream");
	});

	it("truncates an over-long message with a marker", () => {
		const diag = new ExtractionDiagnostics();
		diag.recordFailure("host", "y".repeat(300));
		const [sample] = diag.snapshot().by_tier.host.error_samples;
		expect(sample?.msg).toBe(`${"y".repeat(200)}...[truncated]`);
	});

	it("retains only the most recent 10 samples per tier", () => {
		const diag = new ExtractionDiagnostics();
		for (let i = 0; i < 13; i++) diag.recordFailure("local", `err-${i}`);
		const samples = diag.snapshot().by_tier.local.error_samples;
		expect(samples).toHaveLength(10);
		expect(samples[0]?.msg).toBe("err-3");
		expect(samples[9]?.msg).toBe("err-12");
	});
});

describe("ExtractionDiagnostics totals and snapshot", () => {
	it("routes recordCall to successes, empty, or failures", () => {
		const diag = new ExtractionDiagnostics();
		diag.recordCall({ succeeded: true });
		diag.recordCall({ succeeded: false, allEmpty: true });
		diag.recordCall({ succeeded: false });
		const totals = diag.snapshot().totals;
		expect(totals).toMatchObject({ calls: 3, successes: 1, empty: 1, failures: 1 });
	});

	it("reports a success rate of 0 with no calls and the ratio otherwise", () => {
		const diag = new ExtractionDiagnostics();
		expect(diag.successRate()).toBe(0);
		diag.recordCall({ succeeded: true });
		diag.recordCall({ succeeded: false });
		expect(diag.successRate()).toBe(0.5);
	});

	it("snapshots by-tier error samples as independent copies", () => {
		const diag = new ExtractionDiagnostics();
		diag.recordFailure("host", "first");
		const snap = diag.snapshot();
		snap.by_tier.host.error_samples.push({ at: "x", type: "y", msg: "z" });
		expect(diag.snapshot().by_tier.host.error_samples).toHaveLength(1);
	});

	it("reset returns every counter and sample to zero", () => {
		const diag = new ExtractionDiagnostics();
		diag.recordAttempt("host");
		diag.recordCall({ succeeded: true });
		diag.recordFailure("host", "e");
		diag.reset();
		const snap = diag.snapshot();
		expect(snap.totals).toMatchObject({ calls: 0, successes: 0, failures: 0, empty: 0 });
		expect(snap.by_tier.host).toMatchObject({ attempts: 0, error_samples: [] });
	});
});

describe("diagnostics singleton", () => {
	it("returns the same instance and resetExtractionStats clears it in place", () => {
		const diag = getDiagnostics();
		diag.recordCall({ succeeded: true });
		expect(getDiagnostics()).toBe(diag);
		resetExtractionStats();
		expect(getDiagnostics()).toBe(diag);
		expect(diag.snapshot().totals.calls).toBe(0);
	});
});
