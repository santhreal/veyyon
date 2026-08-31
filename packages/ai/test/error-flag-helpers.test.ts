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
	it("ThinkingLoop is 0x10000", () => {
		expect(Flag.ThinkingLoop).toBe(0x0001_0000);
	});
	it("AuthFailed is 0x1000000", () => {
		expect(Flag.AuthFailed).toBe(0x0100_0000);
	});
	it("Abort is 0x8000000", () => {
		expect(Flag.Abort).toBe(0x0800_0000);
	});
});

describe("KIND_MASK", () => {
	it("does not include Class bit", () => {
		expect((KIND_MASK & Flag.Class) === 0).toBe(true);
	});
	it("includes all non-Class flags", () => {
		expect((KIND_MASK & Flag.ThinkingLoop) !== 0).toBe(true);
		expect((KIND_MASK & Flag.AuthFailed) !== 0).toBe(true);
		expect((KIND_MASK & Flag.Abort) !== 0).toBe(true);
	});
});

describe("ERROR_KIND_LABELS", () => {
	it("does not include Class", () => {
		expect(ERROR_KIND_LABELS.some(([flag]) => flag === Flag.Class)).toBe(false);
	});
	it("includes ThinkingLoop with kebab-case label", () => {
		const entry = ERROR_KIND_LABELS.find(([flag]) => flag === Flag.ThinkingLoop);
		expect(entry).toBeDefined();
		expect(entry?.[1]).toBe("thinking-loop");
	});
	it("includes AuthFailed", () => {
		expect(ERROR_KIND_LABELS.some(([flag]) => flag === Flag.AuthFailed)).toBe(true);
	});
});

describe("create", () => {
	it("creates a classified error id with Class bit", () => {
		const id = create(Flag.AuthFailed);
		expect(isClassified(id)).toBe(true);
		expect(is(id, Flag.AuthFailed)).toBe(true);
	});
	it("combines multiple flags", () => {
		const id = create(Flag.AuthFailed, Flag.Transient);
		expect(is(id, Flag.AuthFailed)).toBe(true);
		expect(is(id, Flag.Transient)).toBe(true);
	});
	it("always sets Class bit", () => {
		const id = create();
		expect(isClassified(id)).toBe(true);
	});
});

describe("is", () => {
	it("returns true when flag is set", () => {
		const id = create(Flag.Timeout);
		expect(is(id, Flag.Timeout)).toBe(true);
	});
	it("returns false when flag is not set", () => {
		const id = create(Flag.Timeout);
		expect(is(id, Flag.AuthFailed)).toBe(false);
	});
	it("returns false for undefined id", () => {
		expect(is(undefined, Flag.Timeout)).toBe(false);
	});
});

describe("isClassified", () => {
	it("returns true for classified id", () => {
		expect(isClassified(create(Flag.Timeout))).toBe(true);
	});
	it("returns false for raw status code", () => {
		expect(isClassified(404)).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(isClassified(undefined)).toBe(false);
	});
	it("returns false for 0", () => {
		expect(isClassified(0)).toBe(false);
	});
});

describe("statusFromId", () => {
	it("returns undefined for classified id", () => {
		expect(statusFromId(create(Flag.Timeout))).toBeUndefined();
	});
	it("returns raw status for unclassified id", () => {
		expect(statusFromId(404)).toBe(404);
	});
	it("returns undefined for undefined", () => {
		expect(statusFromId(undefined)).toBeUndefined();
	});
	it("returns undefined for 0", () => {
		expect(statusFromId(0)).toBeUndefined();
	});
});

describe("stringify", () => {
	it("returns 'none' for 0", () => {
		expect(stringify(0)).toBe("none");
	});
	it("returns 'none' for undefined", () => {
		expect(stringify(undefined)).toBe("none");
	});
	it("returns status: prefix for unclassified", () => {
		expect(stringify(404)).toBe("status:404");
	});
	it("returns flag labels for classified", () => {
		const id = create(Flag.Timeout, Flag.AuthFailed);
		const result = stringify(id);
		expect(result).toContain("timeout");
		expect(result).toContain("auth-failed");
	});
	it("returns classified: prefix for classified with no flags", () => {
		const id = create();
		expect(stringify(id)).toMatch(/^classified:/);
	});
});
