import { describe, expect, it } from "bun:test";
import { isValidJsonSchema, toolWireSchema } from "@veyyon/ai/utils/schema";
import { type TSchema, Type } from "@veyyon/coding-agent/extensibility/typebox";

/**
 * The typebox shim's `Type.*` builders return arktype-backed validator wrappers
 * (`TSchema`), not Zod schemas, so they expose neither `.parse` nor `.safeParse`.
 * The wrapped validator returns the validated value on success, or an object with
 * a `message` property on failure (mirroring the shim's internal `validate`). This
 * helper reproduces a `.safeParse`-style result on top of that contract.
 */
function safeParse(schema: TSchema, value: unknown): { success: boolean; data?: unknown } {
	const result = schema.__validator(value);
	if (result && typeof result === "object" && "message" in result) {
		return { success: false };
	}
	return { success: true, data: result };
}

describe("pi.typebox compatibility shim", () => {
	it("rejects extra properties when additionalProperties is false", () => {
		const schema = Type.Object({ path: Type.String() }, { additionalProperties: false });

		expect(safeParse(schema, { path: "README.md" }).success).toBe(true);
		expect(safeParse(schema, { path: "README.md", mode: "delete" }).success).toBe(false);
	});

	it("preserves numeric enum values from TypeScript enum objects", () => {
		const schema = Type.Enum({ 0: "Fast", 1: "Slow", Fast: 0, Slow: 1 });

		expect(safeParse(schema, 0).success).toBe(true);
		expect(safeParse(schema, 1).success).toBe(true);
		expect(safeParse(schema, "Fast").success).toBe(false);
	});

	it("enforces and emits uniqueItems for arrays", () => {
		const schema = Type.Array(Type.String(), { uniqueItems: true });
		const wire = toolWireSchema({ name: "files", description: "", parameters: { ...schema } });

		expect(safeParse(schema, ["a.ts", "b.ts"]).success).toBe(true);
		expect(safeParse(schema, ["a.ts", "a.ts"]).success).toBe(false);
		expect(wire.uniqueItems).toBe(true);
	});

	it("respects record key schemas", () => {
		const schema = Type.Record(Type.Literal("target"), Type.String());

		expect(safeParse(schema, { target: "ok" }).success).toBe(true);
		expect(safeParse(schema, { other: "bad" }).success).toBe(false);
	});

	it("merges every object passed to Composite", () => {
		const schema = Type.Composite([
			Type.Object({ a: Type.String() }),
			Type.Object({ b: Type.String() }),
			Type.Object({ c: Type.String() }),
		]);

		expect(safeParse(schema, { a: "a", b: "b", c: "c" }).success).toBe(true);
		expect(safeParse(schema, { a: "a", b: "b" }).success).toBe(false);
	});

	it("applies minLength on top of a string format", () => {
		const schema = Type.String({ format: "email", minLength: 20 });

		expect(safeParse(schema, "a@b.co").success).toBe(false);
		expect(safeParse(schema, "longer-address@example.com").success).toBe(true);
	});

	it("applies pattern on top of a url format", () => {
		const schema = Type.String({ format: "url", pattern: "^https://" });

		expect(safeParse(schema, "http://example.com").success).toBe(false);
		expect(safeParse(schema, "https://example.com").success).toBe(true);
	});

	describe("string format: time", () => {
		const schema = Type.String({ format: "time" });

		it("accepts a plain time and the optional fraction and offset", () => {
			expect(safeParse(schema, "12:00:00").success).toBe(true);
			expect(safeParse(schema, "12:00:00.123").success).toBe(true);
			expect(safeParse(schema, "12:00:00.123Z").success).toBe(true);
			expect(safeParse(schema, "12:00:00+05:30").success).toBe(true);
		});

		it("requires a literal dot before the milliseconds, not any character", () => {
			// REGRESSION: the fraction group was `(.\d{3})?` with an unescaped dot, so
			// any character followed by three digits passed. The dot must be literal.
			expect(safeParse(schema, "12:00:00X123").success).toBe(false);
			expect(safeParse(schema, "12:00:00 123").success).toBe(false);
			expect(safeParse(schema, "12:00").success).toBe(false);
		});

		it("accepts any number of fractional-second digits, per RFC 3339", () => {
			// REGRESSION: the fraction group was fixed at `\d{3}`, so it accepted only
			// exactly three digits and rejected valid RFC 3339 times with a shorter or
			// longer fraction. `time-secfrac` is a dot followed by one or more digits.
			expect(safeParse(schema, "12:00:00.5").success).toBe(true);
			expect(safeParse(schema, "12:00:00.12").success).toBe(true);
			expect(safeParse(schema, "12:00:00.123456").success).toBe(true);
			expect(safeParse(schema, "12:00:00.5Z").success).toBe(true);
			expect(safeParse(schema, "12:00:00.123456+05:30").success).toBe(true);
		});

		it("rejects a fractional dot with no digits after it", () => {
			// The fraction is optional, but once the dot appears at least one digit is
			// required: a bare trailing dot is not a valid time.
			expect(safeParse(schema, "12:00:00.").success).toBe(false);
			expect(safeParse(schema, "12:00:00.Z").success).toBe(false);
		});
	});

	describe("string format: date-time", () => {
		const schema = Type.String({ format: "date-time" });

		it("accepts an RFC 3339 date-time with an offset, Z, or bare local time", () => {
			expect(safeParse(schema, "2024-01-01T12:00:00Z").success).toBe(true);
			expect(safeParse(schema, "2024-01-01T12:00:00").success).toBe(true);
			expect(safeParse(schema, "2024-01-01T12:00:00.123Z").success).toBe(true);
			expect(safeParse(schema, "2024-01-01T12:00:00.5+05:30").success).toBe(true);
		});

		it("rejects a value that is not a full date-time", () => {
			// REGRESSION: date-time validated through a bare `new Date(data)`, which
			// accepted a bare year, an English phrase, and a date with no time. A
			// `date-time` must carry both a date and a time separated by `T`.
			expect(safeParse(schema, "2024").success).toBe(false);
			expect(safeParse(schema, "January 1, 2024").success).toBe(false);
			expect(safeParse(schema, "2024-01-01").success).toBe(false);
			expect(safeParse(schema, "12:00:00").success).toBe(false);
			expect(safeParse(schema, "not a date").success).toBe(false);
		});

		it("rejects a shaped date-time with an out-of-range month", () => {
			// The shape passes but month 13 does not exist, so Date yields NaN and the
			// value is rejected. (Day overflow such as Feb 31 is rolled over by the JS
			// Date parser rather than flagged, matching the existing `date` case, so
			// this only pins the month bound that Date does reject.)
			expect(safeParse(schema, "2024-13-01T00:00:00Z").success).toBe(false);
		});
	});

	describe("string format: ipv6", () => {
		const schema = Type.String({ format: "ipv6" });

		it("accepts the zero-compressed :: form and the full eight-group form", () => {
			// REGRESSION: the old regex only matched the fully expanded form, so every
			// common compressed address was wrongly rejected.
			expect(safeParse(schema, "::1").success).toBe(true);
			expect(safeParse(schema, "fe80::1").success).toBe(true);
			expect(safeParse(schema, "::").success).toBe(true);
			expect(safeParse(schema, "2001:db8::8a2e:370:7334").success).toBe(true);
			expect(safeParse(schema, "1:2:3:4:5:6:7:8").success).toBe(true);
		});

		it("rejects a double ::, an over-long group, and non-hex input", () => {
			expect(safeParse(schema, "1::2::3").success).toBe(false);
			expect(safeParse(schema, "12345::").success).toBe(false);
			expect(safeParse(schema, "gggg::1").success).toBe(false);
			expect(safeParse(schema, "1:2:3:4:5:6:7").success).toBe(false);
			expect(safeParse(schema, "").success).toBe(false);
		});
	});

	it("preserves unknown properties by default on Type.Object", () => {
		const schema = Type.Object({ a: Type.String() });
		const parsed = safeParse(schema, { a: "x", extra: 1 });

		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect((parsed.data as { extra?: unknown }).extra).toBe(1);
		}
	});
	// Regression: issue #1101. Real TypeBox lets extension authors do
	// `JSON.stringify(schema)` and get a clean JSON Schema — that's the
	// contract the shim is impersonating. Without a `toJSON` stamp, the shim
	// leaks raw Zod internals (`def`, `_zod`, object-shaped `enum`,
	// `"type":"enum"`) and breaks any pipeline that crosses a JSON boundary.
	describe("JSON.stringify produces valid JSON Schema (TypeBox contract)", () => {
		it("emits clean JSON Schema for a complex object", () => {
			const schema = Type.Object({
				direction: Type.Enum({ upstream: "upstream", downstream: "downstream" }),
				depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 3 })),
				tags: Type.Array(Type.String()),
			});
			const round = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
			expect(isValidJsonSchema(round)).toBe(true);
			// No raw Zod internals leak through.
			expect(round).not.toHaveProperty("_zod");
			expect(round).not.toHaveProperty("def");
			expect(round.type).toBe("object");
		});

		it("emits valid JSON Schema for composition operators", () => {
			const base = Type.Object({ a: Type.String(), b: Type.Number() });
			for (const schema of [
				Type.Partial(base),
				Type.Required(base),
				Type.Pick(base, ["a"]),
				Type.Omit(base, ["a"]),
				Type.Composite([base, Type.Object({ c: Type.Boolean() })]),
			]) {
				const round = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
				expect(isValidJsonSchema(round)).toBe(true);
				expect(round).not.toHaveProperty("_zod");
			}
		});
	});
});
