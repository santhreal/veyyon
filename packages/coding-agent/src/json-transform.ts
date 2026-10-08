/**
 * A bounded walk over JSON that rewrites every string in it, keys included.
 *
 * WHY IT IS ITS OWN MODULE. It used to live at the bottom of `secrets/obfuscator.ts`, and it is
 * not about secrets: it is a general-purpose transformer, and its three callers want three
 * different things from it. `secrets/obfuscator.ts` replaces credentials with placeholders,
 * `argot-wire.ts` expands and contracts a token dictionary, and `provider-boundary.ts` applies
 * whatever transform the session hands it at the final seam. Only the first is a secret.
 *
 * Living there had a measurable cost, which is how it was found. `obfuscator.ts` reaches 65
 * modules, 18 of them `@veyyon/ai/utils/schema` (a JSON Schema validator, imported for
 * `toolWireSchema`), and `provider-boundary.ts` imported ONE function from it. So every module
 * that reaches the provider boundary paid for the schema validator and the secret registry to
 * get a JSON walk: `tools/fs/read.ts` was 24 modules over its ceiling and all 24 were this edge.
 * The walker itself needs two string measurements and nothing else.
 *
 * WHAT IT REFUSES, and why refusing is the whole design. The input is a tool call's arguments,
 * which came from a model, or a request body about to leave the process. Every limit below is a
 * bound on what hostile input can make this loop do, and every `throw` is a refusal rather than
 * a degrade: a walk that silently skipped what it could not handle would pass the untransformed
 * string through, and for the obfuscator that is the credential going out in the clear.
 */

import { isWellFormedUtf16, utf8ByteLength } from "@veyyon/utils/string-length";

/**
 * JSON as it arrives from a caller's object, where an optional property is `undefined`.
 *
 * NAMED FOR WHAT MAKES IT DIFFERENT, because it used to be called `JsonValue` and it is
 * not the repository's `JsonValue` (`@veyyon/utils`): that one's objects hold `JsonValue`
 * and never `undefined`, since `undefined` is not JSON and `JSON.stringify` drops the
 * property rather than encoding it. Two exported types with one name and different
 * contents is a bug waiting for an editor's auto-import to pick the wrong one, and the
 * difference here is load-bearing rather than accidental: {@link mapJsonStrings} walks
 * tool-call arguments that came from a model, and a TypeScript object literal with
 * optional fields is not assignable to the strict shape, so the walker would refuse the
 * values it exists to rewrite.
 */
export type JsonWithOptionalFields =
	| string
	| number
	| boolean
	| null
	| JsonWithOptionalFields[]
	| { [key: string]: JsonWithOptionalFields | undefined };

/** An object of {@link JsonWithOptionalFields}, which is what a tool's arguments are. */
export type JsonRecord = { [key: string]: JsonWithOptionalFields | undefined };

/** Maximum container nesting accepted by the iterative JSON transformation walk. */
export const MAX_JSON_TRANSFORM_DEPTH = 128;
/** Maximum unique containers plus primitive positions visited by one JSON transformation. */
export const MAX_JSON_TRANSFORM_NODES = 100_000;
/** Maximum cumulative plain-object keys visited by one JSON transformation. */
export const MAX_JSON_TRANSFORM_KEYS = 100_000;
/** Maximum cumulative UTF-8 bytes in input or transformed JSON strings and keys. */
export const MAX_JSON_TRANSFORM_STRING_BYTES = 16 * 1024 * 1024;

/** Payload-independent failure categories safe to expose at confidentiality boundaries. */
export type JsonTransformFailureCode =
	| "accessor"
	| "array-items"
	| "cycle"
	| "depth"
	| "input-bytes"
	| "input-utf16"
	| "key-collision"
	| "keys"
	| "nodes"
	| "non-json-value"
	| "non-plain-object"
	| "output-bytes"
	| "output-text"
	| "symbol-key";

/** A bounded-walker refusal whose code never contains payload data. */
export class JsonTransformError extends Error {
	constructor(
		readonly code: JsonTransformFailureCode,
		message: string,
	) {
		super(message);
		this.name = "JsonTransformError";
	}
}

function refuse(code: JsonTransformFailureCode, message: string): never {
	throw new JsonTransformError(code, message);
}

/** Whether a container the walk entered has finished, and what it mapped to once it has. */
interface JsonWalkMemo {
	done: boolean;
	result: unknown;
}

/** A container the walk has entered and not yet finished. */
interface JsonWalkFrame {
	readonly source: unknown[] | Record<string, unknown>;
	/** The record's own keys, or `undefined` for an array. */
	readonly keys: string[] | undefined;
	readonly values: unknown[];
	readonly prototype: object | null;
	readonly depth: number;
	readonly memo: JsonWalkMemo;
	/** Copy of `keys`, allocated when the transform first changes a key. */
	mappedKeys: string[] | undefined;
	/** Copy of `values`, allocated when a child first maps to a different value. */
	mappedValues: unknown[] | undefined;
	/** Index of the next child to visit. */
	next: number;
}

/** Returned by `#enter` for a container it pushed a frame for. */
const ENTERED = Symbol("entered");

function isJsonPrimitive(value: unknown): boolean {
	return (
		value === null ||
		value === undefined ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

/**
 * One bounded walk. The frame stack prevents call-stack exhaustion, and a frame visits its
 * children in order from a cursor, so the transform sees each key before its value and the
 * whole value before the next key. Memo entries reject cycles and map shared DAG nodes once.
 * A frame copies its keys or values only when the transform changes one, and a container is
 * rebuilt only when a copy exists.
 */
class BoundedJsonWalk {
	readonly #fn: (s: string) => string;
	readonly #memo = new WeakMap<object, JsonWalkMemo>();
	readonly #stack: JsonWalkFrame[] = [];
	#nodes = 0;
	#keys = 0;
	#inputBytes = 0;
	#outputBytes = 0;

	constructor(fn: (s: string) => string) {
		this.#fn = fn;
	}

	run(root: unknown): unknown {
		const settled = this.#enter(root, 0);
		if (settled !== ENTERED) return settled;
		const stack = this.#stack;
		for (;;) {
			const frame = stack[stack.length - 1];
			const index = frame.next;
			if (index < frame.values.length) {
				if (frame.keys !== undefined) this.#mapKey(frame, frame.keys, index);
				const value = this.#enter(frame.values[index], frame.depth + 1);
				if (value !== ENTERED) settle(frame, value);
				continue;
			}
			stack.pop();
			const result = finish(frame);
			if (stack.length === 0) return result;
			settle(stack[stack.length - 1], result);
		}
	}

	/** Map a primitive, or push a frame for a container and return {@link ENTERED}. */
	#enter(value: unknown, depth: number): unknown {
		if (typeof value === "object" && value !== null) return this.#enterContainer(value, depth);
		if (!isJsonPrimitive(value)) {
			refuse("non-json-value", "Refusing a non-JSON value in secret transformation data.");
		}
		if (++this.#nodes > MAX_JSON_TRANSFORM_NODES) {
			refuse("nodes", "Refusing a JSON transformation above the node limit.");
		}
		return typeof value === "string" ? this.#mapString(value) : value;
	}

	#enterContainer(value: object, depth: number): unknown {
		if (depth > MAX_JSON_TRANSFORM_DEPTH) {
			refuse("depth", "Refusing a JSON transformation above the depth limit.");
		}
		const memo = this.#memo.get(value);
		if (memo !== undefined) {
			if (!memo.done) refuse("cycle", "Refusing a cyclic JSON transformation graph.");
			return memo.result;
		}
		if (++this.#nodes > MAX_JSON_TRANSFORM_NODES) {
			refuse("nodes", "Refusing a JSON transformation above the node limit.");
		}
		const frame = Array.isArray(value) ? this.#openArray(value, depth) : this.#openRecord(value, depth);
		this.#memo.set(value, frame.memo);
		this.#stack.push(frame);
		return ENTERED;
	}

	#openArray(array: unknown[], depth: number): JsonWalkFrame {
		if (array.length > MAX_JSON_TRANSFORM_NODES - this.#nodes) {
			refuse("array-items", "Refusing a JSON transformation above the array-item limit.");
		}
		const values: unknown[] = [];
		for (let index = 0; index < array.length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(array, index);
			if (descriptor !== undefined && !("value" in descriptor)) {
				refuse("accessor", "Refusing an accessor property in JSON transformation data.");
			}
			values.push(descriptor?.value);
		}
		return openFrame(array, undefined, values, null, depth);
	}

	#openRecord(value: object, depth: number): JsonWalkFrame {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			refuse("non-plain-object", "Refusing a non-plain object in JSON transformation data.");
		}
		const record = value as Record<string, unknown>;
		if (
			Object.getOwnPropertySymbols(record).some(
				symbol => Object.getOwnPropertyDescriptor(record, symbol)?.enumerable,
			)
		) {
			refuse("symbol-key", "Refusing an enumerable symbol key in JSON transformation data.");
		}
		const keys = Object.keys(record);
		const values: unknown[] = [];
		for (const key of keys) {
			if (++this.#keys > MAX_JSON_TRANSFORM_KEYS) {
				refuse("keys", "Refusing a JSON transformation above the object-key limit.");
			}
			const descriptor = Object.getOwnPropertyDescriptor(record, key);
			if (descriptor === undefined || !("value" in descriptor)) {
				refuse("accessor", "Refusing an accessor property in JSON transformation data.");
			}
			values.push(descriptor.value);
		}
		return openFrame(record, keys, values, prototype, depth);
	}

	#mapKey(frame: JsonWalkFrame, keys: string[], index: number): void {
		const mapped = this.#mapString(keys[index]);
		if (mapped === keys[index]) return;
		frame.mappedKeys ??= keys.slice();
		frame.mappedKeys[index] = mapped;
	}

	#mapString(input: string): string {
		if (!isWellFormedUtf16(input)) {
			refuse("input-utf16", "Refusing ill-formed UTF-16 in JSON transformation data.");
		}
		const inputBytes = utf8ByteLength(input);
		this.#inputBytes += inputBytes;
		if (this.#inputBytes > MAX_JSON_TRANSFORM_STRING_BYTES) {
			refuse("input-bytes", "Refusing a JSON transformation above the cumulative input string-byte limit.");
		}
		const output = this.#fn(input);
		if (output === input) {
			this.#outputBytes += inputBytes;
		} else {
			if (typeof output !== "string" || !isWellFormedUtf16(output)) {
				refuse("output-text", "Refusing an ill-formed string produced by a JSON transformation.");
			}
			this.#outputBytes += utf8ByteLength(output);
		}
		if (this.#outputBytes > MAX_JSON_TRANSFORM_STRING_BYTES) {
			refuse("output-bytes", "Refusing a JSON transformation above the cumulative output string-byte limit.");
		}
		return output;
	}
}

/** Record what the child at the frame's cursor mapped to, and advance the cursor. */
function settle(frame: JsonWalkFrame, value: unknown): void {
	const index = frame.next++;
	if (value === frame.values[index]) return;
	frame.mappedValues ??= frame.values.slice();
	frame.mappedValues[index] = value;
}

function finish(frame: JsonWalkFrame): unknown {
	let result: unknown = frame.source;
	if (frame.keys === undefined) {
		if (frame.mappedValues !== undefined) result = rebuiltArray(frame, frame.mappedValues);
	} else if (frame.mappedKeys !== undefined || frame.mappedValues !== undefined) {
		result = rebuiltRecord(frame, frame.mappedKeys ?? frame.keys, frame.mappedValues ?? frame.values);
	}
	frame.memo.done = true;
	frame.memo.result = result;
	return result;
}

function openFrame(
	source: unknown[] | Record<string, unknown>,
	keys: string[] | undefined,
	values: unknown[],
	prototype: object | null,
	depth: number,
): JsonWalkFrame {
	return {
		source,
		keys,
		values,
		prototype,
		depth,
		memo: { done: false, result: undefined },
		mappedKeys: undefined,
		mappedValues: undefined,
		next: 0,
	};
}

/** A copy of the source array with each changed element replaced, so an unchanged hole stays a hole. */
function rebuiltArray(frame: JsonWalkFrame, mappedValues: unknown[]): unknown[] {
	const output = (frame.source as unknown[]).slice();
	for (let index = 0; index < mappedValues.length; index++) {
		if (mappedValues[index] !== frame.values[index]) output[index] = mappedValues[index];
	}
	return output;
}

/**
 * A record with the source's prototype and the mapped fields. Two source keys that map to one
 * key are refused rather than merged; that needs a changed key, since own keys are distinct.
 * Fields are defined, not assigned, so a mapped `__proto__` key is a field and never a prototype.
 */
function rebuiltRecord(frame: JsonWalkFrame, keys: string[], values: unknown[]): Record<string, unknown> {
	if (frame.mappedKeys !== undefined && new Set(keys).size !== keys.length) {
		refuse("key-collision", "Refusing to rewrite two JSON object fields as the same protected key.");
	}
	const output = Object.create(frame.prototype) as Record<string, unknown>;
	for (let index = 0; index < keys.length; index++) {
		Object.defineProperty(output, keys[index], {
			value: values[index],
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return output;
}

/**
 * Map every string in bounded JSON, including object keys.
 *
 * Returns `value` itself when the transform changes nothing, and otherwise copies only the
 * containers on the path to a change. Arrays and plain records are the complete walk domain;
 * typed arrays and class instances are rejected before their properties can be enumerated
 * byte-by-byte.
 */
export function mapJsonStrings<T>(value: T, fn: (s: string) => string): T {
	return new BoundedJsonWalk(fn).run(value) as T;
}
