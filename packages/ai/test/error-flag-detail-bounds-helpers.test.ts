import { describe, expect, it } from "bun:test";
import {
	boundProviderErrorDetail,
	MAX_PROVIDER_ERROR_DETAIL_CHARS,
	NO_PROVIDER_ERROR_DETAIL,
} from "../src/error/detail-bounds";
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
	it("Transient is 0x20000", () => {
		expect(Flag.Transient).toBe(0x0002_0000);
	});
	it("Timeout is 0x40000", () => {
		expect(Flag.Timeout).toBe(0x0004_0000);
	});
	it("UsageLimit is 0x80000", () => {
		expect(Flag.UsageLimit).toBe(0x0008_0000);
	});
	it("AuthFailed is 0x1000000", () => {
		expect(Flag.AuthFailed).toBe(0x0100_0000);
	});
	it("Abort is 0x8000000", () => {
		expect(Flag.Abort).toBe(0x0800_0000);
	});
	it("Grammar is 0x10000000", () => {
		expect(Flag.Grammar).toBe(0x1000_0000);
	});
});

describe("KIND_MASK", () => {
	it("does not include Class bit", () => {
		expect((KIND_MASK & Flag.Class) === 0).toBe(true);
	});
	it("includes all non-Class flags", () => {
		expect((KIND_MASK & Flag.ThinkingLoop) !== 0).toBe(true);
		expect((KIND_MASK & Flag.Transient) !== 0).toBe(true);
		expect((KIND_MASK & Flag.AuthFailed) !== 0).toBe(true);
	});
});

describe("ERROR_KIND_LABELS", () => {
	it("has entry for each non-Class flag", () => {
		const names = ERROR_KIND_LABELS.map(([, label]) => label);
		expect(names).toContain("thinking-loop");
		expect(names).toContain("transient");
		expect(names).toContain("auth-failed");
		expect(names).toContain("grammar");
	});
	it("does not include class", () => {
		const names = ERROR_KIND_LABELS.map(([, label]) => label);
		expect(names).not.toContain("class");
	});
});

describe("create", () => {
	it("creates with Class bit always set", () => {
		const id = create(Flag.Transient);
		expect(isClassified(id)).toBe(true);
	});
	it("combines multiple flags", () => {
		const id = create(Flag.Transient, Flag.Timeout);
		expect(is(id, Flag.Transient)).toBe(true);
		expect(is(id, Flag.Timeout)).toBe(true);
	});
	it("creates with no flags still has Class", () => {
		const id = create();
		expect(isClassified(id)).toBe(true);
	});
});

describe("is", () => {
	it("returns true when flag is set", () => {
		const id = create(Flag.Transient);
		expect(is(id, Flag.Transient)).toBe(true);
	});
	it("returns false when flag is not set", () => {
		const id = create(Flag.Transient);
		expect(is(id, Flag.AuthFailed)).toBe(false);
	});
	it("returns false for undefined id", () => {
		expect(is(undefined, Flag.Transient)).toBe(false);
	});
});

describe("isClassified", () => {
	it("returns true for classified id", () => {
		expect(isClassified(create(Flag.Transient))).toBe(true);
	});
	it("returns false for raw status code", () => {
		expect(isClassified(404)).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(isClassified(undefined)).toBe(false);
	});
	it("returns false for zero", () => {
		expect(isClassified(0)).toBe(false);
	});
});

describe("statusFromId", () => {
	it("returns undefined for classified id", () => {
		expect(statusFromId(create(Flag.Transient))).toBeUndefined();
	});
	it("returns status for unclassified id", () => {
		expect(statusFromId(404)).toBe(404);
	});
	it("returns undefined for zero", () => {
		expect(statusFromId(0)).toBeUndefined();
	});
	it("returns undefined for undefined", () => {
		expect(statusFromId(undefined)).toBeUndefined();
	});
});

describe("stringify", () => {
	it("returns none for zero", () => {
		expect(stringify(0)).toBe("none");
	});
	it("returns none for undefined", () => {
		expect(stringify(undefined)).toBe("none");
	});
	it("returns status:NNN for unclassified", () => {
		expect(stringify(404)).toBe("status:404");
	});
	it("returns labels for classified with flags", () => {
		const id = create(Flag.Transient, Flag.Timeout);
		const result = stringify(id);
		expect(result).toContain("transient");
		expect(result).toContain("timeout");
	});
	it("returns classified:0x... for classified with no flags", () => {
		const id = create();
		expect(stringify(id)).toMatch(/classified:0x/);
	});
});

describe("MAX_PROVIDER_ERROR_DETAIL_CHARS", () => {
	it("is 4096", () => {
		expect(MAX_PROVIDER_ERROR_DETAIL_CHARS).toBe(4096);
	});
});

describe("NO_PROVIDER_ERROR_DETAIL", () => {
	it("is (no detail)", () => {
		expect(NO_PROVIDER_ERROR_DETAIL).toBe("(no detail)");
	});
});

describe("boundProviderErrorDetail", () => {
	it("returns trimmed detail when within bounds", () => {
		expect(boundProviderErrorDetail("some error detail")).toBe("some error detail");
	});
	it("trims whitespace", () => {
		expect(boundProviderErrorDetail("  detail  ")).toBe("detail");
	});
	it("returns no-detail for empty string", () => {
		expect(boundProviderErrorDetail("")).toBe(NO_PROVIDER_ERROR_DETAIL);
	});
	it("returns no-detail for whitespace-only string", () => {
		expect(boundProviderErrorDetail("   ")).toBe(NO_PROVIDER_ERROR_DETAIL);
	});
	it("truncates long detail with message", () => {
		const long = "x".repeat(MAX_PROVIDER_ERROR_DETAIL_CHARS + 100);
		const result = boundProviderErrorDetail(long);
		expect(result.length).toBeLessThan(long.length);
		expect(result).toContain("[truncated");
		expect(result).toContain(`${long.length} chars total`);
	});
	it("does not truncate exactly at limit", () => {
		const exact = "x".repeat(MAX_PROVIDER_ERROR_DETAIL_CHARS);
		expect(boundProviderErrorDetail(exact)).toBe(exact);
	});
	it("truncates one char over limit", () => {
		const over = "x".repeat(MAX_PROVIDER_ERROR_DETAIL_CHARS + 1);
		const result = boundProviderErrorDetail(over);
		expect(result).toContain("[truncated");
	});
});
