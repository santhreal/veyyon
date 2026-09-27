/**
 * WHY: the Google, Cloud Code Assist, MCP and Moonshot normalizers walked a `properties` map as
 * if it were a schema node. A property named `const` was folded into an `enum` on the map, which
 * overwrote a sibling property named `enum` and added `type` and `propertyOrdering` entries to it;
 * a property named `nullable` was dropped wherever the provider strips the `nullable` keyword.
 * A tool whose parameters used those names lost them, and Cloud Code Assist fell back to an
 * empty parameter object.
 *
 * The class this suite closes: a name under a keyword whose value maps names to schemas treated
 * as a keyword. Every provider schema preparation exported from `@veyyon/ai/utils/schema` is
 * swept, under every keyword in `SCHEMA_MAP_KEYWORDS`, with a map naming one property after each
 * keyword the preparations handle. The map must come back with the same names, each holding the
 * schema that property normalizes to on its own. A preparation that strips or renames a map
 * keyword leaves nothing to check, so those pairs are pinned by exact equality. Every provider
 * audit in `validateSchemaCompatibility` must report the same rules for keyword names as for
 * neutral ones.
 *
 * Not caught: a keyword with special handling that is missing from `KEYWORD_NAMES` and from the
 * field tables it is built from.
 */
import { describe, expect, it } from "bun:test";
import * as schemaModule from "@veyyon/ai/utils/schema";
import { type SchemaCompatibilityProvider, validateSchemaCompatibility } from "@veyyon/ai/utils/schema/compatibility";
import {
	COMBINATOR_KEYS,
	LIFTABLE_TO_DESCRIPTION_FIELDS,
	NON_STRUCTURAL_SCHEMA_KEYS,
	SCHEMA_MAP_KEYWORDS,
	UNSUPPORTED_SCHEMA_FIELDS,
} from "@veyyon/ai/utils/schema/fields";

type Schema = Record<string, unknown>;
type Preparation = (schema: Schema) => unknown;

/** Keywords with dedicated handling in a walker, plus every keyword a field table strips or lifts. */
const KEYWORD_NAMES = [
	...new Set([
		"const",
		"nullable",
		"enum",
		"type",
		"required",
		"description",
		"items",
		"any_of",
		"additional_properties",
		"prefix_items",
		"property_ordering",
		"propertyOrdering",
		...COMBINATOR_KEYS,
		...SCHEMA_MAP_KEYWORDS,
		...Object.keys(UNSUPPORTED_SCHEMA_FIELDS),
		...Object.keys(NON_STRUCTURAL_SCHEMA_KEYS),
		...Object.keys(LIFTABLE_TO_DESCRIPTION_FIELDS),
	]),
];

const PREPARATIONS: Array<[string, Preparation]> = Object.entries(schemaModule)
	.filter(([name, value]) => /^(normalize|sanitize)SchemaFor/.test(name) && typeof value === "function")
	.map(([name, value]) => [name, value as Preparation]);

const AUDITED_PROVIDERS: SchemaCompatibilityProvider[] = ["openai-strict", "google", "cloud-code-assist-claude"];

function propertySchema(): Schema {
	return { type: "string", description: "a value", format: "uuid" };
}

function auditedRules(provider: SchemaCompatibilityProvider, mapKeyword: string, names: readonly string[]): string[] {
	const map: Schema = {};
	for (const name of names) map[name] = { type: "string" };
	return validateSchemaCompatibility({ [mapKeyword]: map }, provider)
		.violations.map(violation => violation.rule)
		.sort();
}

/** The map sits one level down, so a root-only `$defs` inliner leaves it in place. */
function holderOf(mapKeyword: string): Schema {
	const map: Schema = {};
	for (const name of KEYWORD_NAMES) map[name] = propertySchema();
	return { type: "object", properties: { holder: { type: "object", [mapKeyword]: map } } };
}

function preparedMap(prepare: Preparation, mapKeyword: string): Schema | undefined {
	const prepared = prepare(holderOf(mapKeyword)) as Schema;
	const holder = (prepared.properties as Schema | undefined)?.holder as Schema | undefined;
	return holder?.[mapKeyword] as Schema | undefined;
}

/** Shapes a walker that reads a map as a node would rewrite: a lifted `format`, a null layer under `items`, two null layers. */
const PROPERTY_SHAPES: Record<string, () => Schema> = {
	"a formatted string": propertySchema,
	"an array of nullable objects": () => ({ type: "array", items: { enum: [{ o: 1 }], nullable: true } }),
	"a nullable const union": () => ({ oneOf: [{ type: "null" }, { const: 1.5 }], nullable: true }),
};

const NEUTRAL_NAME = "neutral_";

/** The prepared schema for a single-entry map under `mapKeyword`, named `name` and listed in `required`. */
function preparedJson(prepare: Preparation, mapKeyword: string, name: string, shape: () => Schema): string {
	const holder: Schema = { type: "object", [mapKeyword]: { [name]: shape() } };
	if (mapKeyword === "properties") holder.required = [name];
	return JSON.stringify(prepare({ type: "object", properties: { holder } }));
}

describe("a property named like a keyword stays a property", () => {
	it("sweeps at least the four provider normalizers", () => {
		expect(PREPARATIONS.map(([name]) => name)).toEqual(
			expect.arrayContaining([
				"normalizeSchemaForGoogle",
				"normalizeSchemaForCCA",
				"normalizeSchemaForMCP",
				"normalizeSchemaForMoonshot",
			]),
		);
	});

	for (const [preparationName, prepare] of PREPARATIONS) {
		for (const mapKeyword of SCHEMA_MAP_KEYWORDS) {
			it(`${preparationName} keeps every name under ${mapKeyword}`, () => {
				const map = preparedMap(prepare, mapKeyword);
				if (map === undefined) return;
				expect(Object.keys(map)).toEqual(KEYWORD_NAMES);
				const alone = prepare(propertySchema());
				for (const name of KEYWORD_NAMES) expect({ name, schema: map[name] }).toEqual({ name, schema: alone });
			});

			it(`${preparationName} prepares an entry under ${mapKeyword} the same whatever its name`, () => {
				const nameDependent: string[] = [];
				for (const [shapeName, shape] of Object.entries(PROPERTY_SHAPES)) {
					const neutral = preparedJson(prepare, mapKeyword, NEUTRAL_NAME, shape);
					for (const name of KEYWORD_NAMES) {
						const expected = neutral.replaceAll(JSON.stringify(NEUTRAL_NAME), JSON.stringify(name));
						if (preparedJson(prepare, mapKeyword, name, shape) !== expected)
							nameDependent.push(`${shapeName} as ${name}`);
					}
				}
				expect(nameDependent).toEqual([]);
			});
		}
	}

	it("drops or renames exactly the pinned map keywords, and never `properties`", () => {
		const notKept: string[] = [];
		for (const [preparationName, prepare] of PREPARATIONS) {
			for (const mapKeyword of SCHEMA_MAP_KEYWORDS) {
				if (preparedMap(prepare, mapKeyword) === undefined) notKept.push(`${preparationName} ${mapKeyword}`);
			}
		}
		// Google and CCA reject these keywords; MCP and Moonshot upgrade `definitions` to `$defs` and
		// `dependencies` to `dependentSchemas`, which MCP keeps and Moonshot drops with its other
		// object-key validators; strict mode has no representation for any of the three open maps.
		expect(notKept).toEqual([
			"normalizeSchemaForCCA patternProperties",
			"normalizeSchemaForCCA dependencies",
			"normalizeSchemaForCCA $defs",
			"normalizeSchemaForCCA definitions",
			"normalizeSchemaForGoogle patternProperties",
			"normalizeSchemaForGoogle dependencies",
			"normalizeSchemaForGoogle $defs",
			"normalizeSchemaForGoogle definitions",
			"normalizeSchemaForMCP dependencies",
			"normalizeSchemaForMCP definitions",
			"normalizeSchemaForMoonshot patternProperties",
			"normalizeSchemaForMoonshot dependencies",
			"normalizeSchemaForMoonshot dependentSchemas",
			"normalizeSchemaForMoonshot definitions",
			"sanitizeSchemaForStrictMode patternProperties",
			"sanitizeSchemaForStrictMode dependencies",
			"sanitizeSchemaForStrictMode dependentSchemas",
		]);
	});

	for (const provider of AUDITED_PROVIDERS) {
		it(`the ${provider} audit reports the same rules for keyword names as for neutral names`, () => {
			const neutralNames = KEYWORD_NAMES.map((_, index) => `p${index}_`);
			for (const mapKeyword of SCHEMA_MAP_KEYWORDS) {
				expect({ mapKeyword, rules: auditedRules(provider, mapKeyword, KEYWORD_NAMES) }).toEqual({
					mapKeyword,
					rules: auditedRules(provider, mapKeyword, neutralNames),
				});
			}
		});
	}
});
