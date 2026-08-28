/** Convert JSON Type Definition (JTD) to TypeScript interface notation. Produces human-readable TypeScript for embedding in system prompts, */

import type { JTDPrimitive } from "./jtd-utils.js";
import {
	isJTDDiscriminator,
	isJTDElements,
	isJTDEnum,
	isJTDProperties,
	isJTDRef,
	isJTDType,
	isJTDValues,
} from "./jtd-utils.js";

const primitiveMap: Record<JTDPrimitive, string> = {
	boolean: "boolean",
	string: "string",
	timestamp: "string",
	float32: "number",
	float64: "number",
	int8: "number",
	uint8: "number",
	int16: "number",
	uint16: "number",
	int32: "number",
	uint32: "number",
};

/** How deep the walk goes before refusing the schema. A self-referential schema is handled properly by the cycle detection below, */
const MAX_SCHEMA_DEPTH = 100;

/** A property name that TypeScript accepts unquoted. */
const KEY_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/** Render an object property name as a TypeScript key. A bare identifier is emitted as-is; anything else is quoted with JSON.stringify so a name carrying */
function safeKey(key: string): string {
	return KEY_IDENTIFIER.test(key) ? key : JSON.stringify(key);
}

/** The sub-schemas reachable from a node, in the order the renderer visits them. */
function childSchemas(schema: object): unknown[] {
	const children: unknown[] = [];
	if (isJTDProperties(schema)) {
		if (schema.properties) {
			const pv = Object.values(schema.properties);
			for (let ci = 0; ci < pv.length; ci++) children.push(pv[ci]!);
		}
		if (schema.optionalProperties) {
			const pv = Object.values(schema.optionalProperties);
			for (let ci = 0; ci < pv.length; ci++) children.push(pv[ci]!);
		}
	}
	if (isJTDElements(schema)) children.push(schema.elements);
	if (isJTDValues(schema)) children.push(schema.values);
	if (isJTDDiscriminator(schema)) {
		const pv = Object.values(schema.mapping);
		for (let ci = 0; ci < pv.length; ci++) children.push(pv[ci]!);
	}
	return children;
}

/** Find the sub-schemas that contain themselves, and give each a name. A schema describing a tree, a linked list, or nested comments refers back to */
function nameRecursiveNodes(root: unknown): Map<object, string> {
	const names = new Map<object, string>();
	const onPath = new Set<object>();

	const walk = (node: unknown, depth: number): void => {
		if (node === null || typeof node !== "object") return;
		if (depth > MAX_SCHEMA_DEPTH) {
			throw new Error(
				`The schema nests more than ${MAX_SCHEMA_DEPTH} levels deep, which is too deep to render into a prompt. Flatten it, or describe the deeply nested part as a string.`,
			);
		}
		const object = node as object;
		if (onPath.has(object)) {
			if (!names.has(object)) names.set(object, names.size === 0 ? "Node" : `Node${names.size + 1}`);
			return;
		}
		onPath.add(object);
		for (const child of childSchemas(object)) walk(child, depth + 1);
		onPath.delete(object);
	};

	walk(root, 0);
	return names;
}

function convertToTypeScript(
	schema: unknown,
	inline = false,
	names?: Map<object, string>,
	atDefinitionSite = false,
): string {
	if (schema === null || schema === undefined || (typeof schema === "object" && Object.keys(schema).length === 0)) {
		return "unknown";
	}

	// A node that refers to itself renders as its name everywhere except at the single place its body is written out. The flag applies to THIS node only:
	if (names && !atDefinitionSite && typeof schema === "object" && names.has(schema as object)) {
		return names.get(schema as object) as string;
	}

	if (isJTDType(schema)) {
		const tsType = primitiveMap[schema.type as JTDPrimitive];
		return tsType ?? "unknown";
	}

	if (isJTDEnum(schema)) {
		// JSON.stringify, not raw `"${v}"`: an enum value containing a double quote,
		// backslash, or control character must be escaped or the emitted union is
		// invalid TypeScript. A JSON string literal is a valid TS string literal.
		return schema.enum.map(v => JSON.stringify(v)).join(" | ");
	}

	if (isJTDElements(schema)) {
		const itemType = convertToTypeScript(schema.elements, true, names);
		if (itemType.includes("\n") || itemType.length > 40) {
			return `Array<${itemType}>`;
		}
		return `${itemType}[]`;
	}

	if (isJTDValues(schema)) {
		const valueType = convertToTypeScript(schema.values, true, names);
		return `Record<string, ${valueType}>`;
	}

	if (isJTDProperties(schema)) {
		const lines: string[] = [];
		lines.push("{");

		if (schema.properties) {
			for (const [key, value] of Object.entries(schema.properties)) {
				const propType = convertToTypeScript(value, true, names);
				lines.push(`  ${safeKey(key)}: ${propType};`);
			}
		}

		if (schema.optionalProperties) {
			for (const [key, value] of Object.entries(schema.optionalProperties)) {
				const propType = convertToTypeScript(value, true, names);
				lines.push(`  ${safeKey(key)}?: ${propType};`);
			}
		}

		lines.push("}");

		if (inline && lines.length <= 4) {
			// Compact single-line for small objects
			const props = lines.slice(1, -1).map(l => l.trim());
			if (props.join(" ").length < 60) {
				return `{ ${props.join(" ")} }`;
			}
		}

		return lines.join("\n");
	}

	if (isJTDDiscriminator(schema)) {
		const variants: string[] = [];
		for (const [tag, props] of Object.entries(schema.mapping)) {
			const propsType = convertToTypeScript(props, true, names);
			// Only strip the braces when there actually are braces. A variant with no fields renders as `unknown` rather than `{}`, and blindly slicing the
			const hasBody = propsType.startsWith("{") && propsType.endsWith("}");
			const inner = hasBody ? propsType.slice(1, -1).trim() : "";
			// safeKey for the discriminator field name and JSON.stringify for the tag value, for the same reason as the property/enum branches: a name or tag
			const tagKey = safeKey(schema.discriminator);
			const tagLiteral = JSON.stringify(tag);
			if (inner.length === 0) {
				variants.push(`{ ${tagKey}: ${tagLiteral} }`);
			} else {
				variants.push(`{ ${tagKey}: ${tagLiteral}; ${inner} }`);
			}
		}
		return variants.join(" | ");
	}

	if (isJTDRef(schema)) {
		return schema.ref;
	}

	return "unknown";
}

/** Convert JTD schema to TypeScript interface string. ```ts */
export function jtdToTypeScript(schema: unknown): string {
	const { definitions, type } = jtdToTypeScriptParts(schema);
	return definitions ? `${definitions}\n\n${type}` : type;
}

/** A schema rendered as TypeScript, with any named interfaces kept separate. They are separate because a caller splicing the type into a larger structure */
export interface RenderedSchemaType {
	/** Interface declarations for self-referential parts. Empty when there are none. */
	definitions: string;
	/** The type expression itself, which may be a bare interface name. */
	type: string;
}

/** Render a JTD schema as TypeScript, expanding self-referential parts into named interfaces rather than recursing until the stack overflows. */
export function jtdToTypeScriptParts(schema: unknown): RenderedSchemaType {
	const names = nameRecursiveNodes(schema);
	if (names.size === 0) {
		return { definitions: "", type: convertToTypeScript(schema, false) };
	}

	// Each named node's body is written out exactly once here. Passing a map
	// without that node in it is what stops `convertToTypeScript` short-circuiting
	// to the name at its own definition site.
	const declarations: string[] = [];
	for (const [node, name] of names) {
		declarations.push(`interface ${name} ${convertToTypeScript(node, false, names, true)}`);
	}

	return {
		definitions: declarations.join("\n\n"),
		type: names.has(schema as object)
			? (names.get(schema as object) as string)
			: convertToTypeScript(schema, false, names),
	};
}
