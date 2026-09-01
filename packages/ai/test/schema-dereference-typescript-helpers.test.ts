import { describe, expect, it } from "bun:test";
import { dereferenceJsonSchema } from "../src/utils/schema/dereference";
import { jsonSchemaToTypeScript } from "../src/utils/schema/typescript";

describe("dereferenceJsonSchema", () => {
	it("returns non-record schema unchanged", () => {
		expect(dereferenceJsonSchema("hello")).toBe("hello");
	});
	it("returns schema without $defs unchanged", () => {
		const schema = { type: "string" };
		expect(dereferenceJsonSchema(schema)).toBe(schema);
	});
	it("dereferences $ref to $defs", () => {
		const schema = {
			$defs: { name: { type: "string" } },
			$ref: "#/$defs/name",
		};
		const result = dereferenceJsonSchema(schema) as Record<string, unknown>;
		expect(result.type).toBe("string");
		expect(result.$ref).toBeUndefined();
	});
	it("dereferences $ref to definitions", () => {
		const schema = {
			definitions: { name: { type: "number" } },
			$ref: "#/definitions/name",
		};
		const result = dereferenceJsonSchema(schema) as Record<string, unknown>;
		expect(result.type).toBe("number");
		expect(result.$ref).toBeUndefined();
	});
	it("handles circular references by returning empty for the ref", () => {
		const schema = {
			$defs: { node: { $ref: "#/$defs/node" } },
			$ref: "#/$defs/node",
		};
		const result = dereferenceJsonSchema(schema) as Record<string, unknown>;
		expect(result.$ref).toBeUndefined();
	});
	it("leaves external refs as-is", () => {
		const schema = {
			$ref: "https://example.com/schema.json",
		};
		const result = dereferenceJsonSchema(schema);
		expect(result).toEqual({ $ref: "https://example.com/schema.json" });
	});
	it("merges sibling properties with resolved ref", () => {
		const schema = {
			$defs: { base: { type: "string" } },
			$ref: "#/$defs/base",
			description: "A name",
		};
		const result = dereferenceJsonSchema(schema) as Record<string, unknown>;
		expect(result.type).toBe("string");
		expect(result.description).toBe("A name");
		expect(result.$ref).toBeUndefined();
	});
	it("dereferences nested refs in properties", () => {
		const schema = {
			$defs: { name: { type: "string" } },
			type: "object",
			properties: {
				firstName: { $ref: "#/$defs/name" },
			},
		};
		const result = dereferenceJsonSchema(schema) as Record<string, unknown>;
		const props = result.properties as Record<string, unknown>;
		expect(props.firstName).toEqual({ type: "string" });
	});
	it("strips $defs from nested result", () => {
		const schema = {
			$defs: { name: { type: "string" } },
			type: "object",
			properties: { name: { $ref: "#/$defs/name" } },
		};
		const result = dereferenceJsonSchema(schema) as Record<string, unknown>;
		const props = result.properties as Record<string, unknown>;
		expect(props.name).toEqual({ type: "string" });
	});
	it("dereferences refs in array items", () => {
		const schema = {
			$defs: { item: { type: "string" } },
			type: "array",
			items: { $ref: "#/$defs/item" },
		};
		const result = dereferenceJsonSchema(schema) as Record<string, unknown>;
		expect(result.items).toEqual({ type: "string" });
	});
});

describe("jsonSchemaToTypeScript", () => {
	it("converts string type", () => {
		expect(jsonSchemaToTypeScript({ type: "string" })).toBe("string");
	});
	it("converts number type", () => {
		expect(jsonSchemaToTypeScript({ type: "number" })).toBe("number");
	});
	it("converts integer type", () => {
		expect(jsonSchemaToTypeScript({ type: "integer" })).toBe("number");
	});
	it("converts boolean type", () => {
		expect(jsonSchemaToTypeScript({ type: "boolean" })).toBe("boolean");
	});
	it("converts null type", () => {
		expect(jsonSchemaToTypeScript({ type: "null" })).toBe("null");
	});
	it("converts array type with items", () => {
		expect(jsonSchemaToTypeScript({ type: "array", items: { type: "string" } })).toBe("string[]");
	});
	it("converts array type without items", () => {
		expect(jsonSchemaToTypeScript({ type: "array" })).toBe("unknown[]");
	});
	it("converts array with items: false", () => {
		expect(jsonSchemaToTypeScript({ type: "array", items: false })).toBe("never[]");
	});
	it("converts array with prefixItems", () => {
		expect(
			jsonSchemaToTypeScript({
				type: "array",
				prefixItems: [{ type: "string" }, { type: "number" }],
			}),
		).toBe("[string, number]");
	});
	it("converts object with properties (optional by default)", () => {
		const result = jsonSchemaToTypeScript({
			type: "object",
			properties: { name: { type: "string" }, age: { type: "number" } },
		});
		expect(result).toContain("name?: string");
		expect(result).toContain("age?: number");
	});
	it("converts const", () => {
		expect(jsonSchemaToTypeScript({ const: "hello" })).toBe('"hello"');
	});
	it("converts const number", () => {
		expect(jsonSchemaToTypeScript({ const: 42 })).toBe("42");
	});
	it("converts enum", () => {
		expect(jsonSchemaToTypeScript({ type: "string", enum: ["a", "b", "c"] })).toBe('"a" | "b" | "c"');
	});
	it("converts empty enum to never", () => {
		expect(jsonSchemaToTypeScript({ type: "string", enum: [] })).toBe("never");
	});
	it("converts anyOf union", () => {
		expect(
			jsonSchemaToTypeScript({
				anyOf: [{ type: "string" }, { type: "number" }],
			}),
		).toBe("string | number");
	});
	it("converts oneOf union", () => {
		expect(
			jsonSchemaToTypeScript({
				oneOf: [{ type: "string" }, { type: "boolean" }],
			}),
		).toBe("string | boolean");
	});
	it("converts allOf intersection", () => {
		const result = jsonSchemaToTypeScript({
			allOf: [
				{ type: "object", properties: { a: { type: "string" } } },
				{ type: "object", properties: { b: { type: "number" } } },
			],
		});
		expect(result).toContain("&");
	});
	it("converts type array to union", () => {
		expect(jsonSchemaToTypeScript({ type: ["string", "null"] })).toBe("string | null");
	});
	it("converts true schema to unknown", () => {
		expect(jsonSchemaToTypeScript(true)).toBe("unknown");
	});
	it("converts false schema to never", () => {
		expect(jsonSchemaToTypeScript(false)).toBe("never");
	});
	it("converts unknown schema to unknown", () => {
		expect(jsonSchemaToTypeScript("hello")).toBe("unknown");
	});
	it("converts $ref to resolved definition", () => {
		expect(
			jsonSchemaToTypeScript({
				$defs: { name: { type: "string" } },
				$ref: "#/$defs/name",
			}),
		).toBe("string");
	});
	it("converts $ref to definition name when unresolved", () => {
		expect(jsonSchemaToTypeScript({ $ref: "#/$defs/external" })).toBe("external");
	});
	it("deduplicates union members", () => {
		expect(
			jsonSchemaToTypeScript({
				anyOf: [{ type: "string" }, { type: "string" }],
			}),
		).toBe("string");
	});
	it("emits property description as JsDoc", () => {
		const result = jsonSchemaToTypeScript({
			type: "object",
			properties: { name: { type: "string", description: "The name" } },
		});
		expect(result).toContain("The name");
	});
	it("uses custom indent", () => {
		const result = jsonSchemaToTypeScript(
			{ type: "object", properties: { name: { type: "string" } } },
			{ indent: "\t", comments: false },
		);
		expect(result).toContain("\t");
	});
	it("converts nested object", () => {
		const result = jsonSchemaToTypeScript({
			type: "object",
			properties: {
				address: {
					type: "object",
					properties: { city: { type: "string" } },
				},
			},
		});
		expect(result).toContain("address?:");
		expect(result).toContain("city?: string");
	});
	it("converts array of objects", () => {
		const result = jsonSchemaToTypeScript({
			type: "array",
			items: { type: "object", properties: { name: { type: "string" } } },
		});
		expect(result).toContain("name?: string");
	});
	it("converts object with required and optional fields", () => {
		const result = jsonSchemaToTypeScript({
			type: "object",
			properties: { name: { type: "string" }, age: { type: "number" } },
			required: ["name"],
		});
		expect(result).toContain("name: string");
		expect(result).toContain("age?: number");
	});
	it("converts empty object to {}", () => {
		expect(jsonSchemaToTypeScript({ type: "object" })).toBe("{}");
	});
	it("converts object with additionalProperties: true", () => {
		expect(jsonSchemaToTypeScript({ type: "object", additionalProperties: true })).toBe("Record<string, unknown>");
	});
	it("converts object with additionalProperties schema", () => {
		expect(
			jsonSchemaToTypeScript({
				type: "object",
				additionalProperties: { type: "string" },
			}),
		).toBe("Record<string, string>");
	});
	it("converts object with non-safe key using JSON.stringify", () => {
		const result = jsonSchemaToTypeScript({
			type: "object",
			properties: { "my-key": { type: "string" } },
		});
		expect(result).toContain('"my-key"');
	});
	it("converts object with multi-line description", () => {
		const result = jsonSchemaToTypeScript({
			type: "object",
			properties: {
				name: { type: "string", description: "Line 1\nLine 2" },
			},
		});
		expect(result).toContain("Line 1");
		expect(result).toContain("Line 2");
	});
	it("converts array with long inner type using Array<>", () => {
		const result = jsonSchemaToTypeScript({
			type: "array",
			items: {
				type: "object",
				properties: {
					longFieldName: { type: "string" },
					anotherLongField: { type: "number" },
				},
			},
		});
		expect(result).toContain("Array<");
	});
	it("disables comments with comments: false", () => {
		const result = jsonSchemaToTypeScript(
			{
				type: "object",
				properties: { name: { type: "string", description: "The name" } },
			},
			{ comments: false },
		);
		expect(result).not.toContain("The name");
	});
});
