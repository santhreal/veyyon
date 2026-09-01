import { describe, expect, it } from "bun:test";
import {
	ANTHROPIC_STRICT_INCOMPATIBLE_KEYWORDS,
	ANTHROPIC_STRICT_TOOL_ALLOWLIST,
	ANTHROPIC_TOOL_SCHEMA_ARRAY_KEEP,
	ANTHROPIC_TOOL_SCHEMA_OBJECT_KEEP,
	ANTHROPIC_TOOL_SCHEMA_STRING_FORMATS,
	ANTHROPIC_TOOL_SCHEMA_STRING_KEEP,
	ANTHROPIC_TOOL_SCHEMA_UNIVERSAL_KEEP,
	hasNullVariant,
	MAX_ANTHROPIC_STRICT_OPTIONAL_PARAMETERS,
	MAX_ANTHROPIC_STRICT_TOOLS,
	MAX_ANTHROPIC_STRICT_UNION_PARAMETERS,
	normalizeAnthropicToolSchema,
} from "../src/providers/anthropic-schema";

describe("ANTHROPIC_TOOL_SCHEMA_UNIVERSAL_KEEP", () => {
	it("includes type", () => {
		expect(ANTHROPIC_TOOL_SCHEMA_UNIVERSAL_KEEP.has("type")).toBe(true);
	});
	it("includes anyOf", () => {
		expect(ANTHROPIC_TOOL_SCHEMA_UNIVERSAL_KEEP.has("anyOf")).toBe(true);
	});
	it("includes description", () => {
		expect(ANTHROPIC_TOOL_SCHEMA_UNIVERSAL_KEEP.has("description")).toBe(true);
	});
	it("does not include properties", () => {
		expect(ANTHROPIC_TOOL_SCHEMA_UNIVERSAL_KEEP.has("properties")).toBe(false);
	});
});

describe("ANTHROPIC_TOOL_SCHEMA_OBJECT_KEEP", () => {
	it("includes properties, required, additionalProperties", () => {
		expect(ANTHROPIC_TOOL_SCHEMA_OBJECT_KEEP.has("properties")).toBe(true);
		expect(ANTHROPIC_TOOL_SCHEMA_OBJECT_KEEP.has("required")).toBe(true);
		expect(ANTHROPIC_TOOL_SCHEMA_OBJECT_KEEP.has("additionalProperties")).toBe(true);
	});
});

describe("ANTHROPIC_TOOL_SCHEMA_ARRAY_KEEP", () => {
	it("includes items, prefixItems, minItems", () => {
		expect(ANTHROPIC_TOOL_SCHEMA_ARRAY_KEEP.has("items")).toBe(true);
		expect(ANTHROPIC_TOOL_SCHEMA_ARRAY_KEEP.has("prefixItems")).toBe(true);
		expect(ANTHROPIC_TOOL_SCHEMA_ARRAY_KEEP.has("minItems")).toBe(true);
	});
});

describe("ANTHROPIC_TOOL_SCHEMA_STRING_KEEP", () => {
	it("includes format", () => {
		expect(ANTHROPIC_TOOL_SCHEMA_STRING_KEEP.has("format")).toBe(true);
	});
});

describe("ANTHROPIC_TOOL_SCHEMA_STRING_FORMATS", () => {
	it("includes date-time", () => {
		expect(ANTHROPIC_TOOL_SCHEMA_STRING_FORMATS.has("date-time")).toBe(true);
	});
	it("includes uri", () => {
		expect(ANTHROPIC_TOOL_SCHEMA_STRING_FORMATS.has("uri")).toBe(true);
	});
	it("includes uuid", () => {
		expect(ANTHROPIC_TOOL_SCHEMA_STRING_FORMATS.has("uuid")).toBe(true);
	});
	it("does not include unknown formats", () => {
		expect(ANTHROPIC_TOOL_SCHEMA_STRING_FORMATS.has("custom")).toBe(false);
	});
});

describe("ANTHROPIC_STRICT_TOOL_ALLOWLIST", () => {
	it("includes bash, python, edit, find", () => {
		expect(ANTHROPIC_STRICT_TOOL_ALLOWLIST.has("bash")).toBe(true);
		expect(ANTHROPIC_STRICT_TOOL_ALLOWLIST.has("python")).toBe(true);
		expect(ANTHROPIC_STRICT_TOOL_ALLOWLIST.has("edit")).toBe(true);
		expect(ANTHROPIC_STRICT_TOOL_ALLOWLIST.has("find")).toBe(true);
	});
	it("does not include arbitrary tool names", () => {
		expect(ANTHROPIC_STRICT_TOOL_ALLOWLIST.has("custom_tool")).toBe(false);
	});
});

describe("MAX_ANTHROPIC_STRICT_*", () => {
	it("MAX_TOOLS is 20", () => {
		expect(MAX_ANTHROPIC_STRICT_TOOLS).toBe(20);
	});
	it("MAX_OPTIONAL_PARAMETERS is 24", () => {
		expect(MAX_ANTHROPIC_STRICT_OPTIONAL_PARAMETERS).toBe(24);
	});
	it("MAX_UNION_PARAMETERS is 16", () => {
		expect(MAX_ANTHROPIC_STRICT_UNION_PARAMETERS).toBe(16);
	});
});

describe("ANTHROPIC_STRICT_INCOMPATIBLE_KEYWORDS", () => {
	it("is non-empty array", () => {
		expect(ANTHROPIC_STRICT_INCOMPATIBLE_KEYWORDS.length).toBeGreaterThan(0);
	});
});

describe("hasNullVariant", () => {
	it("returns true when type array includes null", () => {
		expect(hasNullVariant({ type: ["string", "null"] })).toBe(true);
	});
	it("returns false when type array does not include null", () => {
		expect(hasNullVariant({ type: ["string", "number"] })).toBe(false);
	});
	it("returns true when anyOf has a null variant", () => {
		expect(hasNullVariant({ anyOf: [{ type: "string" }, { type: "null" }] })).toBe(true);
	});
	it("returns false when anyOf has no null variant", () => {
		expect(hasNullVariant({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe(false);
	});
	it("returns false for schema without type or anyOf", () => {
		expect(hasNullVariant({ description: "test" })).toBe(false);
	});
	it("returns false for string type", () => {
		expect(hasNullVariant({ type: "string" })).toBe(false);
	});
});

describe("normalizeAnthropicToolSchema", () => {
	it("returns null for null input", () => {
		expect(normalizeAnthropicToolSchema(null)).toBeNull();
	});
	it("returns undefined for undefined input", () => {
		expect(normalizeAnthropicToolSchema(undefined)).toBeUndefined();
	});
	it("passes through string type", () => {
		const result = normalizeAnthropicToolSchema({ type: "string" }) as Record<string, unknown>;
		expect(result.type).toBe("string");
	});
	it("keeps properties for object type", () => {
		const result = normalizeAnthropicToolSchema({
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		}) as Record<string, unknown>;
		expect(result.properties).toBeDefined();
		expect(result.required).toEqual(["name"]);
	});
	it("keeps items for array type", () => {
		const result = normalizeAnthropicToolSchema({
			type: "array",
			items: { type: "string" },
		}) as Record<string, unknown>;
		expect(result.items).toBeDefined();
	});
	it("keeps description", () => {
		const result = normalizeAnthropicToolSchema({
			type: "string",
			description: "a name",
		}) as Record<string, unknown>;
		expect(result.description).toBe("a name");
	});
	it("drops non-keep keys from object schema", () => {
		const result = normalizeAnthropicToolSchema({
			type: "object",
			properties: { name: { type: "string" } },
			pattern: "^abc",
		}) as Record<string, unknown>;
		expect(result.pattern).toBeUndefined();
	});
	it("keeps enum", () => {
		const result = normalizeAnthropicToolSchema({
			type: "string",
			enum: ["a", "b"],
		}) as Record<string, unknown>;
		expect(result.enum).toEqual(["a", "b"]);
	});
	it("keeps anyOf in nested property", () => {
		const result = normalizeAnthropicToolSchema({
			type: "object",
			properties: {
				val: { anyOf: [{ type: "string" }, { type: "number" }] },
			},
		}) as Record<string, unknown>;
		const props = result.properties as Record<string, Record<string, unknown>>;
		expect(props.val?.anyOf).toBeDefined();
	});
	it("keeps format for string with known format", () => {
		const result = normalizeAnthropicToolSchema({
			type: "string",
			format: "date-time",
		}) as Record<string, unknown>;
		expect(result.format).toBe("date-time");
	});
	it("drops format for string with unknown format", () => {
		const result = normalizeAnthropicToolSchema({
			type: "string",
			format: "custom",
		}) as Record<string, unknown>;
		expect(result.format).toBeUndefined();
	});
});
