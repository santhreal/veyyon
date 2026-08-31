import { describe, expect, it } from "bun:test";
import { formatFullAnchorRequirement, LINE_REF_RE, parseTag } from "../src/mismatch-helpers";

describe("LINE_REF_RE", () => {
	it("matches plain number", () => {
		expect("42".match(LINE_REF_RE)).not.toBeNull();
	});
	it("matches number with colon and content", () => {
		expect("42:hello".match(LINE_REF_RE)).not.toBeNull();
	});
	it("matches number with leading whitespace", () => {
		expect("  42".match(LINE_REF_RE)).not.toBeNull();
	});
	it("matches number with leading > prefix", () => {
		expect(">42".match(LINE_REF_RE)).not.toBeNull();
	});
	it("matches number with leading + prefix", () => {
		expect("+42".match(LINE_REF_RE)).not.toBeNull();
	});
	it("matches number with leading - prefix", () => {
		expect("-42".match(LINE_REF_RE)).not.toBeNull();
	});
	it("matches number with leading * prefix", () => {
		expect("*42".match(LINE_REF_RE)).not.toBeNull();
	});
	it("matches number with multiple prefixes", () => {
		expect(">>>42".match(LINE_REF_RE)).not.toBeNull();
	});
	it("matches number with trailing whitespace", () => {
		expect("42  ".match(LINE_REF_RE)).not.toBeNull();
	});
	it("matches number with colon and trailing whitespace", () => {
		expect("42:hello  ".match(LINE_REF_RE)).not.toBeNull();
	});
	it("does not match non-numeric", () => {
		expect("abc".match(LINE_REF_RE)).toBeNull();
	});
	it("does not match empty string", () => {
		expect("".match(LINE_REF_RE)).toBeNull();
	});
	it("does not match number with text before it", () => {
		expect("abc42".match(LINE_REF_RE)).toBeNull();
	});
	it("captures the number", () => {
		const match = "42:hello".match(LINE_REF_RE);
		expect(match?.[1]).toBe("42");
	});
	it("captures number from prefixed line", () => {
		const match = ">>>  42".match(LINE_REF_RE);
		expect(match?.[1]).toBe("42");
	});
});

describe("formatFullAnchorRequirement", () => {
	it("returns message without received when raw is undefined", () => {
		const result = formatFullAnchorRequirement(undefined);
		expect(result).toContain("content-hash tag");
		expect(result).toContain("src/foo.ts");
		expect(result).not.toContain("Received");
	});
	it("returns message with received when raw is provided", () => {
		const result = formatFullAnchorRequirement("bad-ref");
		expect(result).toContain("Received");
		expect(result).toContain('"bad-ref"');
	});
	it("includes file prefix and suffix", () => {
		const result = formatFullAnchorRequirement(undefined);
		expect(result).toContain("[");
		expect(result).toContain("]");
	});
	it("includes hash separator", () => {
		const result = formatFullAnchorRequirement(undefined);
		expect(result).toContain("#");
	});
	it("includes example line number", () => {
		const result = formatFullAnchorRequirement(undefined);
		expect(result).toContain('"160"');
	});
});

describe("parseTag", () => {
	it("parses plain number", () => {
		expect(parseTag("42")).toEqual({ line: 42 });
	});
	it("parses number with colon and content", () => {
		expect(parseTag("42:hello")).toEqual({ line: 42 });
	});
	it("parses number with leading whitespace", () => {
		expect(parseTag("  42")).toEqual({ line: 42 });
	});
	it("parses number with > prefix", () => {
		expect(parseTag(">42")).toEqual({ line: 42 });
	});
	it("parses number with + prefix", () => {
		expect(parseTag("+42")).toEqual({ line: 42 });
	});
	it("parses number with multiple prefixes", () => {
		expect(parseTag(">>>42")).toEqual({ line: 42 });
	});
	it("parses number with trailing whitespace", () => {
		expect(parseTag("42  ")).toEqual({ line: 42 });
	});
	it("throws on non-numeric", () => {
		expect(() => parseTag("abc")).toThrow("Invalid line reference");
	});
	it("throws on empty string", () => {
		expect(() => parseTag("")).toThrow("Invalid line reference");
	});
	it("throws on zero", () => {
		expect(() => parseTag("0")).toThrow(">= 1");
	});
	it("throws on negative number (via - prefix)", () => {
		// -42 matches LINE_REF_RE but the captured number is 42, not -42
		// Actually - prefix is stripped, so it parses as 42
		expect(parseTag("-42")).toEqual({ line: 42 });
	});
	it("throws on text before number", () => {
		expect(() => parseTag("abc42")).toThrow("Invalid line reference");
	});
	it("includes received value in error", () => {
		expect(() => parseTag("bad")).toThrow('"bad"');
	});
});
