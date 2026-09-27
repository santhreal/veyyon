/**
 * Schema nodes covering each rewrite `sanitizeSchemaForStrictMode` applies, and the containers it
 * recurses into, shared by the suites that sweep them. The forms mirror the sanitizer's branches
 * (`$ref` with siblings, single `allOf`, `type` arrays, `const`, `enum`, `default`, `nullable`),
 * which are code paths rather than an enumerable table; the combinator containers are read from
 * `COMBINATOR_KEYS`, so a new combinator is swept without an edit here.
 */
import { COMBINATOR_KEYS } from "@veyyon/ai/utils/schema";

export type Schema = Record<string, unknown>;

export const STRICT_REWRITE_FORMS: Record<string, () => Schema> = {
	"nullable scalar with a description": () => ({ type: "string", nullable: true, description: "a name" }),
	"nullable scalar": () => ({ type: "integer", nullable: true }),
	"nullable object": () => ({ type: "object", properties: { x: { type: "string" } }, nullable: true }),
	"nullable const": () => ({ const: "only", nullable: true }),
	"type array": () => ({ type: ["string", "null"], description: "maybe" }),
	const: () => ({ const: "only" }),
	"const outside its enum": () => ({ type: "string", enum: ["a", "b"], const: "c" }),
	"const inside its enum": () => ({ type: "string", enum: ["a", "b"], const: "b" }),
	"type array with a const outside its enum": () => ({ type: ["string", "integer"], enum: ["a", 1], const: "b" }),
	"type array its enum narrows to one type": () => ({
		type: ["string", "integer"],
		enum: ["a", 1.5],
		description: "d",
	}),
	"default folded into the description": () => ({ type: "string", description: "mode", default: "fast" }),
	"single allOf": () => ({ allOf: [{ type: "string", nullable: true }], description: "wrapped" }),
	"single allOf with a const outside its enum": () => ({ allOf: [{ type: "string", enum: ["a"], const: "z" }] }),
	"$ref with a sibling": () => ({ $ref: "#/$defs/Leaf", description: "a leaf" }),
	"$ref with a const sibling outside the definition's enum": () => ({ $ref: "#/$defs/Mode", const: "idle" }),
	plain: () => ({ type: "boolean" }),
};

/** Each container places the node twice, alongside the `$defs` the `$ref` forms resolve against. */
export const STRICT_CONTAINERS: Record<string, (node: Schema) => Schema> = {
	properties: node => ({ type: "object", properties: { a: node, b: node } }),
	"items tuple": node => ({ type: "array", items: [node, node] }),
	prefixItems: node => ({ type: "array", prefixItems: [node, node] }),
	"property and items": node => ({
		type: "object",
		properties: { a: node, list: { type: "array", items: node } },
	}),
	$defs: node => ({ type: "object", properties: {}, $defs: { A: node, B: node } }),
	definitions: node => ({ type: "object", properties: {}, definitions: { A: node, B: node } }),
	...Object.fromEntries(
		COMBINATOR_KEYS.map(key => [key, (node: Schema): Schema => ({ [key]: [node, { type: "number" }, node] })]),
	),
};

/**
 * `root` with fresh copies of the `$defs` entries the `$ref` forms resolve against: `Leaf` carries
 * a keyword strict mode strips, so an unsanitized copy never equals its sanitized form, and `Mode`
 * is an enum a `$ref` with a `const` sibling merges into. Neither holds an object map strict mode
 * cannot represent, so `tryEnforceStrictSchema` sanitizes every container rather than falling back.
 */
export function withStrictRefDefs(root: Schema): Schema {
	const defs = (root.$defs as Schema | undefined) ?? {};
	const leaf: Schema = {
		type: "object",
		properties: { id: { type: "string", format: "uuid" } },
		required: ["id"],
	};
	const mode: Schema = { type: "string", enum: ["fast", "slow"] };
	return { ...root, $defs: { ...defs, Leaf: leaf, Mode: mode } };
}
