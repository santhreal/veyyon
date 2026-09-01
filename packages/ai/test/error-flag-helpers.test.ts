import { describe, expect, it } from "bun:test";
import {
	create,
	ERROR_KIND_LABELS,
	Flag,
	is,
	isClassified,
	KIND_MASK,
	statusFromId,
	stringify,
} from "../src/error/flag";

describe("Flag", () => {
	it("Class is 0x1000", () => {
		expect(Flag.Class).toBe(0x1000);
	});
	it("each flag is a unique power of 2 or mask", () => {
		const values = Object.values(Flag);
		const unique = new Set(values);
		expect(unique.size).toBe(values.length);
	});
});

describe("KIND_MASK", () => {
	it("includes all flags except Class", () => {
		expect(KIND_MASK & Flag.Class).toBe(0);
	});
	it("includes Transient", () => {
		expect(KIND_MASK & Flag.Transient).toBe(Flag.Transient);
	});
	it("includes UsageLimit", () => {
		expect(KIND_MASK & Flag.UsageLimit).toBe(Flag.UsageLimit);
	});
});

describe("ERROR_KIND_LABELS", () => {
	it("has one entry per non-Class flag", () => {
		expect(ERROR_KIND_LABELS.length).toBe(Object.keys(Flag).length - 1);
	});
	it("labels are kebab-case", () => {
		for (const [, label] of ERROR_KIND_LABELS) {
			expect(label).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
		}
	});
});

describe("create", () => {
	it("ORs flags together with Class", () => {
		const id = create(Flag.Transient);
		expect(id & Flag.Transient).toBe(Flag.Transient);
		expect(id & Flag.Class).toBe(Flag.Class);
	});
	it("with no args still sets Class", () => {
		expect(create() & Flag.Class).toBe(Flag.Class);
	});
	it("combines multiple flags", () => {
		const id = create(Flag.Transient, Flag.Timeout);
		expect(id & Flag.Transient).toBe(Flag.Transient);
		expect(id & Flag.Timeout).toBe(Flag.Timeout);
	});
});

describe("is", () => {
	it("returns true when flag is set", () => {
		const id = create(Flag.Transient);
		expect(is(id, Flag.Transient)).toBe(true);
	});
	it("returns false when flag is not set", () => {
		const id = create(Flag.Transient);
		expect(is(id, Flag.Timeout)).toBe(false);
	});
	it("returns false for undefined id", () => {
		expect(is(undefined, Flag.Transient)).toBe(false);
	});
	it("returns false for 0 id", () => {
		expect(is(0, Flag.Transient)).toBe(false);
	});
});

describe("isClassified", () => {
	it("returns true for classified id", () => {
		expect(isClassified(create(Flag.Transient))).toBe(true);
	});
	it("returns false for bare status", () => {
		expect(isClassified(404)).toBe(false);
	});
	it("returns false for 0", () => {
		expect(isClassified(0)).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(isClassified(undefined)).toBe(false);
	});
});

describe("statusFromId", () => {
	it("returns status for bare id", () => {
		expect(statusFromId(404)).toBe(404);
	});
	it("returns undefined for classified id", () => {
		expect(statusFromId(create(Flag.Transient))).toBeUndefined();
	});
	it("returns undefined for 0", () => {
		expect(statusFromId(0)).toBeUndefined();
	});
	it("returns undefined for undefined", () => {
		expect(statusFromId(undefined)).toBeUndefined();
	});
});

describe("stringify", () => {
	it("returns 'none' for 0", () => {
		expect(stringify(0)).toBe("none");
	});
	it("returns 'none' for undefined", () => {
		expect(stringify(undefined)).toBe("none");
	});
	it("returns 'status:N' for bare status", () => {
		expect(stringify(404)).toBe("status:404");
	});
	it("returns label for single flag", () => {
		const id = create(Flag.Transient);
		const result = stringify(id);
		expect(result).toContain("transient");
	});
	it("returns joined labels for multiple flags", () => {
		const id = create(Flag.Transient, Flag.Timeout);
		const result = stringify(id);
		expect(result).toContain("transient");
		expect(result).toContain("timeout");
		expect(result).toContain("|");
	});
});
