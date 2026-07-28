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
 * get a JSON walk: `tools/read.ts` was 24 modules over its ceiling and all 24 were this edge.
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

interface JsonWalkFrame {
	original: unknown[] | Record<string, unknown>;
	kind: "array" | "object";
	keys: string[];
	sourceValues: unknown[];
	mappedKeys: string[];
	mappedValues: unknown[];
	prototype: object | null;
	target: JsonWalkTarget;
}

interface JsonWalkTarget {
	frame: JsonWalkFrame | undefined;
	index: number;
}

type JsonWalkEvent =
	| { type: "visit"; value: unknown; depth: number; target: JsonWalkTarget }
	| { type: "key"; key: string; frame: JsonWalkFrame; index: number }
	| { type: "complete"; frame: JsonWalkFrame };

/**
 * Map every string in bounded JSON, including object keys.
 *
 * The explicit stack prevents call-stack exhaustion. Gray/done memo states reject cycles and map
 * shared DAG nodes once, while completion allocates only containers whose key or value changed.
 * Arrays and plain records are the complete walk domain; typed arrays and class instances are
 * rejected before their properties can be enumerated byte-by-byte.
 */
export function mapJsonStrings<T>(value: T, fn: (s: string) => string): T {
	const memo = new WeakMap<object, { status: "visiting" | "done"; result?: unknown }>();
	const events: JsonWalkEvent[] = [{ type: "visit", value, depth: 0, target: { frame: undefined, index: 0 } }];
	let rootResult: unknown;
	let visitedNodes = 0;
	let visitedKeys = 0;
	let inputStringBytes = 0;
	let outputStringBytes = 0;

	const mapString = (input: string): string => {
		if (!isWellFormedUtf16(input)) {
			throw new Error("Refusing ill-formed UTF-16 in JSON transformation data.");
		}
		inputStringBytes += utf8ByteLength(input);
		if (inputStringBytes > MAX_JSON_TRANSFORM_STRING_BYTES) {
			throw new Error("Refusing a JSON transformation above the cumulative input string-byte limit.");
		}
		const output = fn(input);
		if (typeof output !== "string" || !isWellFormedUtf16(output)) {
			throw new Error("Refusing an ill-formed string produced by a JSON transformation.");
		}
		outputStringBytes += utf8ByteLength(output);
		if (outputStringBytes > MAX_JSON_TRANSFORM_STRING_BYTES) {
			throw new Error("Refusing a JSON transformation above the cumulative output string-byte limit.");
		}
		return output;
	};

	const assign = (target: JsonWalkTarget, result: unknown): void => {
		if (target.frame === undefined) rootResult = result;
		else target.frame.mappedValues[target.index] = result;
	};

	while (events.length > 0) {
		const event = events.pop();
		if (event === undefined) break;
		if (event.type === "key") {
			event.frame.mappedKeys[event.index] = mapString(event.key);
			continue;
		}
		if (event.type === "complete") {
			const frame = event.frame;
			let changed = false;
			if (frame.kind === "array") {
				for (let index = 0; index < frame.sourceValues.length; index++) {
					if (frame.mappedValues[index] !== frame.sourceValues[index]) {
						changed = true;
						break;
					}
				}
				let result: unknown = frame.original;
				if (changed) {
					const output = (frame.original as unknown[]).slice();
					for (let index = 0; index < frame.sourceValues.length; index++) {
						if (frame.mappedValues[index] !== frame.sourceValues[index]) {
							output[index] = frame.mappedValues[index];
						}
					}
					result = output;
				}
				assign(frame.target, result);
				const memoEntry = memo.get(frame.original);
				if (memoEntry === undefined) throw new Error("JSON transformation memo state was lost.");
				memoEntry.status = "done";
				memoEntry.result = result;
				continue;
			}

			const seenKeys = new Set<string>();
			for (let index = 0; index < frame.keys.length; index++) {
				const mappedKey = frame.mappedKeys[index];
				if (seenKeys.has(mappedKey)) {
					throw new Error("Refusing to rewrite two JSON object fields as the same protected key.");
				}
				seenKeys.add(mappedKey);
				if (mappedKey !== frame.keys[index] || frame.mappedValues[index] !== frame.sourceValues[index]) {
					changed = true;
				}
			}
			let result: unknown = frame.original;
			if (changed) {
				const output = Object.create(frame.prototype) as Record<string, unknown>;
				for (let index = 0; index < frame.keys.length; index++) {
					Object.defineProperty(output, frame.mappedKeys[index], {
						value: frame.mappedValues[index],
						enumerable: true,
						configurable: true,
						writable: true,
					});
				}
				result = output;
			}
			assign(frame.target, result);
			const memoEntry = memo.get(frame.original);
			if (memoEntry === undefined) throw new Error("JSON transformation memo state was lost.");
			memoEntry.status = "done";
			memoEntry.result = result;
			continue;
		}

		const current = event.value;
		if (typeof current === "string") {
			if (++visitedNodes > MAX_JSON_TRANSFORM_NODES) {
				throw new Error("Refusing a JSON transformation above the node limit.");
			}
			assign(event.target, mapString(current));
			continue;
		}
		if (
			current === null ||
			current === undefined ||
			typeof current === "boolean" ||
			(typeof current === "number" && Number.isFinite(current))
		) {
			if (++visitedNodes > MAX_JSON_TRANSFORM_NODES) {
				throw new Error("Refusing a JSON transformation above the node limit.");
			}
			assign(event.target, current);
			continue;
		}
		if (typeof current !== "object") {
			throw new Error("Refusing a non-JSON value in secret transformation data.");
		}
		if (event.depth > MAX_JSON_TRANSFORM_DEPTH) {
			throw new Error("Refusing a JSON transformation above the depth limit.");
		}
		const existingMemo = memo.get(current);
		if (existingMemo?.status === "visiting") {
			throw new Error("Refusing a cyclic JSON transformation graph.");
		}
		if (existingMemo?.status === "done") {
			assign(event.target, existingMemo.result);
			continue;
		}
		if (++visitedNodes > MAX_JSON_TRANSFORM_NODES) {
			throw new Error("Refusing a JSON transformation above the node limit.");
		}

		const isArray = Array.isArray(current);
		const prototype = Object.getPrototypeOf(current);
		if (!isArray && prototype !== Object.prototype && prototype !== null) {
			throw new Error("Refusing a non-plain object in JSON transformation data.");
		}
		const keys: string[] = [];
		const sourceValues: unknown[] = [];
		if (isArray) {
			if (current.length > MAX_JSON_TRANSFORM_NODES - visitedNodes) {
				throw new Error("Refusing a JSON transformation above the array-item limit.");
			}
			for (let index = 0; index < current.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
				if (descriptor !== undefined && !("value" in descriptor)) {
					throw new Error("Refusing an accessor property in JSON transformation data.");
				}
				keys.push(String(index));
				sourceValues.push(descriptor?.value);
			}
		} else {
			const record = current as Record<string, unknown>;
			if (
				Object.getOwnPropertySymbols(record).some(
					symbol => Object.getOwnPropertyDescriptor(record, symbol)?.enumerable,
				)
			) {
				throw new Error("Refusing an enumerable symbol key in JSON transformation data.");
			}
			for (const key in record) {
				if (!Object.hasOwn(record, key)) continue;
				if (++visitedKeys > MAX_JSON_TRANSFORM_KEYS) {
					throw new Error("Refusing a JSON transformation above the object-key limit.");
				}
				const descriptor = Object.getOwnPropertyDescriptor(record, key);
				if (descriptor === undefined || !("value" in descriptor)) {
					throw new Error("Refusing an accessor property in JSON transformation data.");
				}
				keys.push(key);
				sourceValues.push(descriptor.value);
			}
		}

		const frame: JsonWalkFrame = {
			original: current as unknown[] | Record<string, unknown>,
			kind: isArray ? "array" : "object",
			keys,
			sourceValues,
			mappedKeys: isArray ? keys : new Array(keys.length),
			mappedValues: new Array(sourceValues.length),
			prototype,
			target: event.target,
		};
		memo.set(current, { status: "visiting" });
		assign(event.target, current);
		events.push({ type: "complete", frame });
		for (let index = sourceValues.length - 1; index >= 0; index--) {
			events.push({
				type: "visit",
				value: sourceValues[index],
				depth: event.depth + 1,
				target: { frame, index },
			});
			if (!isArray) events.push({ type: "key", key: keys[index], frame, index });
		}
	}

	return rootResult as T;
}
