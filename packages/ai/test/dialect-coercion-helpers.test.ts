/**
 * Contract tests for the small pure helpers in dialect/coercion.ts that the
 * in-band tool-call parser leans on: partial-suffix overlap (used to withhold a
 * stream tail that might be the start of a tool tag), Kimi function-name
 * normalization, and JSON type classification. Each is an off-by-one or
 * mis-mapping away from leaking tag bytes or misrouting a tool call, so pin them.
 */
import { describe, expect, it } from "bun:test";
import {
	getOwnArg,
	jsonTypeOf,
	mintToolCallId,
	normalizeKimiFunctionName,
	partialSuffixOverlap,
	partialSuffixOverlapAny,
	setToolArg,
} from "@veyyon/ai/dialect/coercion";

describe("partialSuffixOverlap", () => {
	it("returns the length of the longest text suffix that is a prefix of the tag", () => {
		// "hello<tool" ends with "<tool", the first 5 chars of "<tool_call>".
		expect(partialSuffixOverlap("hello<tool", "<tool_call>")).toBe(5);
		expect(partialSuffixOverlap("a<", "<b>")).toBe(1);
	});

	it("returns 0 when no suffix of the text starts the tag", () => {
		expect(partialSuffixOverlap("hello", "<tool_call>")).toBe(0);
	});

	it("never reports a complete tag as a partial overlap (caps at tag.length-1)", () => {
		// A fully-present tag is handled by the complete-tag path, not this one, so
		// the overlap must stay strictly shorter than the whole tag.
		expect(partialSuffixOverlap("<tool_call>", "<tool_call>")).toBe(0);
		expect(partialSuffixOverlap("x<tool>", "<tool>")).toBe(0);
	});

	it("handles empty text and empty tag as no overlap", () => {
		expect(partialSuffixOverlap("", "<x>")).toBe(0);
		expect(partialSuffixOverlap("abc", "")).toBe(0);
	});
});

describe("partialSuffixOverlapAny", () => {
	it("returns the best overlap across all candidate tags", () => {
		// "</too" is a 5-char prefix of "</tool>" and no prefix of "<tool>".
		expect(partialSuffixOverlapAny("x</too", ["<tool>", "</tool>"])).toBe(5);
	});

	it("returns 0 for an empty tag list", () => {
		expect(partialSuffixOverlapAny("abc", [])).toBe(0);
	});
});

describe("normalizeKimiFunctionName", () => {
	it("drops an id suffix after the first colon and keeps the last dotted segment", () => {
		expect(normalizeKimiFunctionName("functions.get_weather:0")).toBe("get_weather");
		expect(normalizeKimiFunctionName("a.b.c")).toBe("c");
	});

	it("returns a bare name unchanged and trims surrounding whitespace", () => {
		expect(normalizeKimiFunctionName("foo:1")).toBe("foo");
		expect(normalizeKimiFunctionName(" a.b : 2")).toBe("b");
		expect(normalizeKimiFunctionName("")).toBe("");
	});
});

describe("jsonTypeOf", () => {
	it("classifies values by their JSON type", () => {
		expect(jsonTypeOf(null)).toBe("null");
		expect(jsonTypeOf(3)).toBe("number");
		expect(jsonTypeOf(3n)).toBe("number");
		expect(jsonTypeOf(true)).toBe("boolean");
		expect(jsonTypeOf("x")).toBe("string");
		expect(jsonTypeOf([1])).toBe("object");
		expect(jsonTypeOf({})).toBe("object");
	});

	it("maps undefined (not a JSON value) to object, the catch-all branch", () => {
		expect(jsonTypeOf(undefined)).toBe("object");
	});
});

describe("setToolArg (prototype-safe argument assignment)", () => {
	// The kv / streaming dialects build a tool call's `arguments` object one
	// model-supplied key at a time. A bare `obj[key] = value` for the accessor
	// keys below does NOT create a normal own property: it either mutates the
	// object's prototype or is silently discarded. `setToolArg` must make every
	// such key land as an ordinary own data property, matching how `JSON.parse`
	// (the JSON-body dialects) represents the exact same key. These tests lock
	// out a regression that would let model output corrupt the arguments object.

	it("stores an object value under a literal __proto__ as an own property without touching the prototype", () => {
		const args: Record<string, unknown> = {};
		const payload = { polluted: true };
		setToolArg(args, "__proto__", payload);

		// A bare `args["__proto__"] = payload` would REPLACE the prototype and drop
		// the key. The safe path keeps the object's prototype intact.
		expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
		expect(Object.hasOwn(args, "__proto__")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(args, "__proto__")?.value).toBe(payload);
		expect(Object.keys(args)).toEqual(["__proto__"]);
		// No phantom inherited members leaked in from the payload.
		expect((args as { polluted?: unknown }).polluted).toBeUndefined();
	});

	it("stores a string value under a literal __proto__ that a bare assignment would silently drop", () => {
		const args: Record<string, unknown> = {};
		// `{}["__proto__"] = "x"` is a no-op: the prototype setter ignores non-object
		// values, so without the fix the argument vanishes entirely.
		setToolArg(args, "__proto__", "x");

		expect(Object.hasOwn(args, "__proto__")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(args, "__proto__")?.value).toBe("x");
		expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
	});

	it("stores literal constructor and prototype keys as own data properties, not built-in shadows", () => {
		const args: Record<string, unknown> = {};
		setToolArg(args, "constructor", "c");
		setToolArg(args, "prototype", "p");

		expect(Object.getOwnPropertyDescriptor(args, "constructor")?.value).toBe("c");
		expect(Object.getOwnPropertyDescriptor(args, "prototype")?.value).toBe("p");
		expect(new Set(Object.keys(args))).toEqual(new Set(["constructor", "prototype"]));
	});

	it("assigns ordinary keys through the plain fast path and overwrites in place", () => {
		const args: Record<string, unknown> = {};
		setToolArg(args, "path", "a.ts");
		setToolArg(args, "path", "b.ts");
		setToolArg(args, "count", 2);

		expect(args).toEqual({ path: "b.ts", count: 2 });
		expect(Object.keys(args)).toEqual(["path", "count"]);
	});

	it("produces the same own-key shape as JSON.parse for a __proto__ argument", () => {
		// The JSON-body dialects get their arguments from JSON.parse; the kv dialects
		// must be byte-for-byte equivalent so both representations behave identically.
		const viaJson = JSON.parse('{"__proto__": {"a": 1}}') as Record<string, unknown>;
		const viaHelper: Record<string, unknown> = {};
		setToolArg(viaHelper, "__proto__", { a: 1 });

		expect(Object.hasOwn(viaJson, "__proto__")).toBe(true);
		expect(Object.hasOwn(viaHelper, "__proto__")).toBe(true);
		expect(Object.getPrototypeOf(viaHelper)).toBe(Object.getPrototypeOf(viaJson));
		expect(Object.getOwnPropertyDescriptor(viaHelper, "__proto__")?.value).toEqual(
			Object.getOwnPropertyDescriptor(viaJson, "__proto__")?.value,
		);
	});
});

describe("getOwnArg (prototype-safe argument read)", () => {
	it("returns the own value written under __proto__, never the inherited prototype", () => {
		const args: Record<string, unknown> = {};
		setToolArg(args, "__proto__", "streamed-so-far");

		// A bare `args["__proto__"]` read returns Object.prototype (an object), which
		// would defeat the streaming parsers' `typeof prior === "string"` guard.
		expect(getOwnArg(args, "__proto__")).toBe("streamed-so-far");
	});

	it("returns undefined for __proto__ before anything is stored, not Object.prototype", () => {
		const args: Record<string, unknown> = {};
		expect(getOwnArg(args, "__proto__")).toBeUndefined();
		// The bare read would have returned the built-in prototype object here.
		expect(args["__proto__" as keyof typeof args]).toBe(Object.prototype);
	});

	it("reads ordinary keys and reports undefined for absent ones", () => {
		const args: Record<string, unknown> = { path: "a.ts" };
		expect(getOwnArg(args, "path")).toBe("a.ts");
		expect(getOwnArg(args, "missing")).toBeUndefined();
	});
});

describe("mintToolCallId", () => {
	it("produces the ptc_<base36>_<base36> shape", () => {
		expect(mintToolCallId()).toMatch(/^ptc_[0-9a-z]+_[0-9a-z]+$/);
	});

	it("never collides across many consecutive calls in the same millisecond", () => {
		// The monotonic counter suffix, not the timestamp, is what keeps ids unique
		// when many are minted within one millisecond. A collision would cross-wire
		// two tool calls to the same result.
		const ids = new Set<string>();
		for (let i = 0; i < 5_000; i++) ids.add(mintToolCallId());
		expect(ids.size).toBe(5_000);
	});
});
