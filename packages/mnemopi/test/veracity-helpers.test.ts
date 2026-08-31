import { describe, expect, it } from "bun:test";
import {
	aggregateVeracity,
	clampVeracity,
	isVeracity,
	resetVeracityWarnings,
	VERACITY_ALLOWED,
	VERACITY_DESCRIPTION,
	VERACITY_MEANINGS,
	VERACITY_VALUES,
	VERACITY_WEIGHTS,
	type Veracity,
	weightForVeracity,
} from "../src/core/veracity";

describe("VERACITY_MEANINGS", () => {
	it("has meaning for stated", () => {
		expect(VERACITY_MEANINGS.stated).toBeTruthy();
	});
	it("has meaning for false", () => {
		expect(VERACITY_MEANINGS.false).toBeTruthy();
	});
	it("has 8 veracity levels", () => {
		expect(Object.keys(VERACITY_MEANINGS)).toHaveLength(8);
	});
});

describe("VERACITY_VALUES", () => {
	it("contains all veracity levels", () => {
		expect(VERACITY_VALUES).toContain("stated");
		expect(VERACITY_VALUES).toContain("true");
		expect(VERACITY_VALUES).toContain("likely_true");
		expect(VERACITY_VALUES).toContain("unknown");
		expect(VERACITY_VALUES).toContain("inferred");
		expect(VERACITY_VALUES).toContain("imported");
		expect(VERACITY_VALUES).toContain("tool");
		expect(VERACITY_VALUES).toContain("false");
	});
	it("has 8 values", () => {
		expect(VERACITY_VALUES).toHaveLength(8);
	});
});

describe("VERACITY_DESCRIPTION", () => {
	it("is a non-empty string containing all levels", () => {
		expect(VERACITY_DESCRIPTION.length).toBeGreaterThan(0);
		expect(VERACITY_DESCRIPTION).toContain("stated");
		expect(VERACITY_DESCRIPTION).toContain("false");
	});
});

describe("VERACITY_WEIGHTS", () => {
	it("stated is 1.0", () => {
		expect(VERACITY_WEIGHTS.stated).toBe(1.0);
	});
	it("false is 0", () => {
		expect(VERACITY_WEIGHTS.false).toBe(0);
	});
	it("tool is 0.5", () => {
		expect(VERACITY_WEIGHTS.tool).toBe(0.5);
	});
	it("unknown is 0.8", () => {
		expect(VERACITY_WEIGHTS.unknown).toBe(0.8);
	});
	it("inferred is 0.7", () => {
		expect(VERACITY_WEIGHTS.inferred).toBe(0.7);
	});
	it("imported is 0.6", () => {
		expect(VERACITY_WEIGHTS.imported).toBe(0.6);
	});
});

describe("VERACITY_ALLOWED", () => {
	it("has true for all veracity levels", () => {
		for (const value of VERACITY_VALUES) {
			expect(VERACITY_ALLOWED[value]).toBe(true);
		}
	});
});

describe("isVeracity", () => {
	it("returns true for valid veracity", () => {
		expect(isVeracity("stated")).toBe(true);
		expect(isVeracity("true")).toBe(true);
		expect(isVeracity("false")).toBe(true);
		expect(isVeracity("unknown")).toBe(true);
	});
	it("returns false for invalid veracity", () => {
		expect(isVeracity("maybe")).toBe(false);
		expect(isVeracity("")).toBe(false);
	});
	it("returns false for non-veracity strings", () => {
		expect(isVeracity("toString")).toBe(false);
		expect(isVeracity("constructor")).toBe(false);
	});
});

describe("clampVeracity", () => {
	it("returns unknown for null", () => {
		expect(clampVeracity(null)).toBe("unknown");
	});
	it("returns unknown for undefined", () => {
		expect(clampVeracity(undefined)).toBe("unknown");
	});
	it("returns unknown for empty string", () => {
		expect(clampVeracity("")).toBe("unknown");
	});
	it("returns valid veracity as-is", () => {
		expect(clampVeracity("stated")).toBe("stated");
		expect(clampVeracity("false")).toBe("false");
	});
	it("normalizes to lowercase", () => {
		expect(clampVeracity("STATED")).toBe("stated");
		expect(clampVeracity("True")).toBe("true");
	});
	it("trims whitespace", () => {
		expect(clampVeracity("  stated  ")).toBe("stated");
	});
	it("returns unknown for invalid veracity", () => {
		resetVeracityWarnings();
		expect(clampVeracity("maybe")).toBe("unknown");
	});
});

describe("weightForVeracity", () => {
	it("returns weight for valid veracity", () => {
		expect(weightForVeracity("stated")).toBe(1.0);
		expect(weightForVeracity("false")).toBe(0);
	});
	it("returns weight for unknown veracity", () => {
		expect(weightForVeracity("maybe")).toBe(VERACITY_WEIGHTS.unknown);
	});
	it("returns weight for null", () => {
		expect(weightForVeracity(null)).toBe(VERACITY_WEIGHTS.unknown);
	});
});

describe("aggregateVeracity", () => {
	it("returns unknown for null", () => {
		expect(aggregateVeracity(null)).toBe("unknown");
	});
	it("returns unknown for undefined", () => {
		expect(aggregateVeracity(undefined)).toBe("unknown");
	});
	it("returns unknown for empty array", () => {
		expect(aggregateVeracity([])).toBe("unknown");
	});
	it("returns the only valid veracity", () => {
		expect(aggregateVeracity(["stated"])).toBe("stated");
	});
	it("returns most common veracity", () => {
		expect(aggregateVeracity(["stated", "stated", "inferred"])).toBe("stated");
	});
	it("prefers non-unknown over unknown", () => {
		expect(aggregateVeracity(["unknown", "stated"])).toBe("stated");
	});
	it("returns unknown when all are unknown", () => {
		expect(aggregateVeracity(["unknown", "unknown"])).toBe("unknown");
	});
	it("filters out invalid veracities", () => {
		expect(aggregateVeracity(["maybe", "stated"])).toBe("stated");
	});
	it("returns unknown when all are invalid", () => {
		expect(aggregateVeracity(["maybe", "perhaps"])).toBe("unknown");
	});
	it("prefers lower weight on tie", () => {
		// stated and true both have weight 1.0, so on tie the lower weight wins
		// Since both are 1.0, the first one encountered wins
		const result = aggregateVeracity(["stated", "true"]);
		expect(["stated", "true"]).toContain(result);
	});
	it("prefers lower weight when counts are equal", () => {
		// inferred (0.7) and tool (0.5) both appear once
		// tool has lower weight, so tool wins
		expect(aggregateVeracity(["inferred", "tool"])).toBe("tool");
	});
});
