import { describe, expect, it } from "bun:test";
import {
	normalizeSchemaForMCP,
	normalizeSchemaForMoonshot,
	OLLAMA_OPEN_SUBSCHEMA_WIDENING,
	OLLAMA_SCHEMA_ARRAY_KEYS,
	OLLAMA_SCHEMA_MAP_KEYS,
	OLLAMA_SCHEMA_VALUE_KEYS,
	OPENAI_RESPONSES_SCHEMA_ARRAY_KEYS,
	OPENAI_RESPONSES_SCHEMA_MAP_KEYS,
	OPENAI_RESPONSES_SCHEMA_VALUE_KEYS,
	OPENAI_UNSUPPORTED_REGEX_LOOKAROUNDS,
	sanitizeSchemaForOllama,
	sanitizeSchemaForOpenAIResponses,
	sanitizeSchemaForStrictMode,
	tryEnforceStrictSchema,
} from "../src/utils/schema/normalize-helpers";

describe("normalizeSchemaForMCP", () => {
	it("returns string schema unchanged", () => {
		expect(normalizeSchemaForMCP({ type: "string" })).toEqual({ type: "string" });
	});
	it("strips nullable keyword", () => {
		const result = normalizeSchemaForMCP({ type: "string", nullable: true }) as Record<string, unknown>;
		expect(result.nullable).toBeUndefined();
	});
	it("preserves properties", () => {
		const result = normalizeSchemaForMCP({
			type: "object",
			properties: { name: { type: "string" } },
		}) as Record<string, unknown>;
		expect(result.properties).toBeDefined();
	});
});

describe("normalizeSchemaForMoonshot", () => {
	it("returns string schema unchanged", () => {
		expect(normalizeSchemaForMoonshot({ type: "string" })).toEqual({ type: "string" });
	});
	it("strips nullable keyword", () => {
		const result = normalizeSchemaForMoonshot({ type: "string", nullable: true }) as Record<string, unknown>;
		expect(result.nullable).toBeUndefined();
	});
	it("normalizes type array to nullable for string|null", () => {
		const result = normalizeSchemaForMoonshot({ type: ["string", "null"] }) as Record<string, unknown>;
		expect(result.type).toBe("string");
	});
});

describe("OLLAMA_SCHEMA_ARRAY_KEYS", () => {
	it("contains anyOf, oneOf, allOf, prefixItems", () => {
		expect(OLLAMA_SCHEMA_ARRAY_KEYS.has("anyOf")).toBe(true);
		expect(OLLAMA_SCHEMA_ARRAY_KEYS.has("oneOf")).toBe(true);
		expect(OLLAMA_SCHEMA_ARRAY_KEYS.has("allOf")).toBe(true);
		expect(OLLAMA_SCHEMA_ARRAY_KEYS.has("prefixItems")).toBe(true);
	});
	it("does not contain properties", () => {
		expect(OLLAMA_SCHEMA_ARRAY_KEYS.has("properties")).toBe(false);
	});
});

describe("OLLAMA_SCHEMA_MAP_KEYS", () => {
	it("contains properties", () => {
		expect(OLLAMA_SCHEMA_MAP_KEYS.has("properties")).toBe(true);
	});
	it("contains $defs", () => {
		expect(OLLAMA_SCHEMA_MAP_KEYS.has("$defs")).toBe(true);
	});
});

describe("OLLAMA_SCHEMA_VALUE_KEYS", () => {
	it("contains items", () => {
		expect(OLLAMA_SCHEMA_VALUE_KEYS.has("items")).toBe(true);
	});
});

describe("OLLAMA_OPEN_SUBSCHEMA_WIDENING", () => {
	it("has anyOf with all primitive types", () => {
		expect(Array.isArray(OLLAMA_OPEN_SUBSCHEMA_WIDENING.anyOf)).toBe(true);
		const types = OLLAMA_OPEN_SUBSCHEMA_WIDENING.anyOf.map((s: { type: string }) => s.type);
		expect(types).toContain("string");
		expect(types).toContain("number");
		expect(types).toContain("boolean");
		expect(types).toContain("object");
		expect(types).toContain("array");
		expect(types).toContain("null");
	});
	it("is frozen", () => {
		expect(Object.isFrozen(OLLAMA_OPEN_SUBSCHEMA_WIDENING)).toBe(true);
	});
});

describe("sanitizeSchemaForOllama", () => {
	it("returns simple string schema", () => {
		const result = sanitizeSchemaForOllama({ type: "string" });
		expect(result.type).toBe("string");
	});
	it("handles object schema with properties", () => {
		const result = sanitizeSchemaForOllama({
			type: "object",
			properties: { name: { type: "string" } },
		});
		expect(result.type).toBe("object");
		expect(result.properties).toBeDefined();
	});
});

describe("OPENAI_RESPONSES_SCHEMA_ARRAY_KEYS", () => {
	it("contains anyOf, oneOf, allOf, prefixItems", () => {
		expect(OPENAI_RESPONSES_SCHEMA_ARRAY_KEYS.has("anyOf")).toBe(true);
		expect(OPENAI_RESPONSES_SCHEMA_ARRAY_KEYS.has("prefixItems")).toBe(true);
	});
});

describe("OPENAI_RESPONSES_SCHEMA_MAP_KEYS", () => {
	it("contains properties and $defs", () => {
		expect(OPENAI_RESPONSES_SCHEMA_MAP_KEYS.has("properties")).toBe(true);
		expect(OPENAI_RESPONSES_SCHEMA_MAP_KEYS.has("$defs")).toBe(true);
	});
});

describe("OPENAI_RESPONSES_SCHEMA_VALUE_KEYS", () => {
	it("contains items and additionalProperties", () => {
		expect(OPENAI_RESPONSES_SCHEMA_VALUE_KEYS.has("items")).toBe(true);
		expect(OPENAI_RESPONSES_SCHEMA_VALUE_KEYS.has("additionalProperties")).toBe(true);
	});
});

describe("OPENAI_UNSUPPORTED_REGEX_LOOKAROUNDS", () => {
	it("contains = and !", () => {
		expect(OPENAI_UNSUPPORTED_REGEX_LOOKAROUNDS.has("=")).toBe(true);
		expect(OPENAI_UNSUPPORTED_REGEX_LOOKAROUNDS.has("!")).toBe(true);
	});
	it("contains <= and <!", () => {
		expect(OPENAI_UNSUPPORTED_REGEX_LOOKAROUNDS.has("<=")).toBe(true);
		expect(OPENAI_UNSUPPORTED_REGEX_LOOKAROUNDS.has("<!")).toBe(true);
	});
});

describe("sanitizeSchemaForOpenAIResponses", () => {
	it("returns simple string schema", () => {
		const result = sanitizeSchemaForOpenAIResponses({ type: "string" });
		expect(result.type).toBe("string");
	});
	it("handles object schema", () => {
		const result = sanitizeSchemaForOpenAIResponses({
			type: "object",
			properties: { name: { type: "string" } },
		});
		expect(result.type).toBe("object");
	});
});

describe("sanitizeSchemaForStrictMode", () => {
	it("returns string schema unchanged", () => {
		const result = sanitizeSchemaForStrictMode({ type: "string" });
		expect(result.type).toBe("string");
	});
	it("strips forbidden keys from string schema", () => {
		const result = sanitizeSchemaForStrictMode({ type: "string", format: "email" });
		expect(result.format).toBeUndefined();
	});
	it("handles array schema", () => {
		const result = sanitizeSchemaForStrictMode({ type: "array", items: { type: "string" } });
		expect(result.type).toBe("array");
	});
	it("handles anyOf", () => {
		const result = sanitizeSchemaForStrictMode({
			anyOf: [{ type: "string" }, { type: "number" }],
		});
		expect(result.anyOf).toBeDefined();
	});
	it("preserves object properties", () => {
		const result = sanitizeSchemaForStrictMode({
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		});
		expect(result.type).toBe("object");
		expect(result.properties).toBeDefined();
	});
});

describe("tryEnforceStrictSchema", () => {
	it("returns strict result for valid schema", () => {
		const result = tryEnforceStrictSchema({ type: "string" });
		expect(result.strict).toBe(true);
		expect(result.schema.type).toBe("string");
	});
	it("returns strict result for valid object schema", () => {
		const result = tryEnforceStrictSchema({
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		});
		expect(result.strict).toBe(true);
		expect(result.schema.additionalProperties).toBe(false);
	});
	it("caches result on repeated calls", () => {
		const schema = { type: "string" };
		const r1 = tryEnforceStrictSchema(schema);
		const r2 = tryEnforceStrictSchema(schema);
		expect(r1).toBe(r2);
	});
	it("returns non-strict for schema with unrepresentable object map", () => {
		const result = tryEnforceStrictSchema({
			type: "object",
			additionalProperties: { type: "string" },
		});
		expect(result.strict).toBe(false);
	});
	it("enforces all properties required in strict mode", () => {
		const result = tryEnforceStrictSchema({
			type: "object",
			properties: { name: { type: "string" }, age: { type: "number" } },
			required: ["name"],
		});
		expect(result.strict).toBe(true);
		const required = result.schema.required as string[];
		expect(required).toContain("name");
		expect(required).toContain("age");
	});
});
