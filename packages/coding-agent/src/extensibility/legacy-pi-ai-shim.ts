/** Compatibility shim for legacy extensions importing the package root of `@veyyon/ai` (or one of its aliased scopes like `@earendil-works/pi-ai` */
import {
	calculateCost,
	getBundledModel,
	getBundledModels,
	getBundledProviders,
	modelsAreEqual,
} from "@veyyon/catalog/models";
import { type TSchema, Type } from "./typebox";

export interface StringEnumOptions<T extends string> {
	description?: string;
	default?: T;
	examples?: T[];
	[key: string]: unknown;
}

function stringEnumWireSchema<T extends string | number>(
	values: readonly T[] | Record<string, T>,
	options: StringEnumOptions<any> | undefined,
) {
	const enumValues = Array.isArray(values) ? values.slice() : Object.values(values);
	const schema: Record<string, unknown> = {
		type: "string",
		enum: enumValues,
	};
	if (!options) return schema;
	for (const key in options) {
		if (options[key] !== undefined) {
			schema[key] = options[key];
		}
	}
	return schema;
}

export function StringEnum<T extends string | number>(
	values: readonly T[] | Record<string, T>,
	options?: StringEnumOptions<any>,
): TSchema {
	const opts = {
		description: options?.description ?? "Legacy string enum compatibility schema",
		...options,
	};
	const schema: TSchema = Array.isArray(values) && values.length === 0 ? Type.Never(opts) : Type.Enum(values, opts);
	const wire = stringEnumWireSchema(values, options);
	// The typebox shim serializes a schema through its ENUMERABLE JSON Schema keywords, and Bun's JSON.stringify (unlike Node's) ignores a non-enumerable `toJSON`. Relying
	for (const key of Object.keys(schema)) {
		delete (schema as Record<string, unknown>)[key];
	}
	Object.assign(schema, wire);
	// Keep a matching (hidden) toJSON so an explicit `schema.toJSON()` and JSON.stringify
	// agree on every runtime, Node included.
	Object.defineProperty(schema, "toJSON", {
		value: () => ({ ...wire }),
		enumerable: false,
		writable: true,
		configurable: true,
	});
	return schema;
}

export * from "@veyyon/ai";
/** Compatibility re-exports for catalog symbols that pi-ai historically exposed from its own barrel prior to the `refactor(catalog)!: split model catalog */
export { calculateCost, getBundledModel, getBundledModels, getBundledProviders, modelsAreEqual, Type };
export const getModel = getBundledModel;
export const getModels = getBundledModels;
