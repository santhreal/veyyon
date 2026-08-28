/** A bounded walk over JSON that rewrites every string in it, keys included. not about secrets: it is a general-purpose transformer, and its three callers want three */

import { isWellFormedUtf16, utf8ByteLength } from "@veyyon/utils/string-length";

/** JSON as it arrives from a caller's object, where an optional property is `undefined`. NAMED FOR WHAT MAKES IT DIFFERENT, because it used to be called `JsonValue` and it is */
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
	| "internal"
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

/** Map every string in bounded JSON, including object keys. The explicit stack prevents call-stack exhaustion. Gray/done memo states reject cycles and map */
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
			refuse("input-utf16", "Refusing ill-formed UTF-16 in JSON transformation data.");
		}
		inputStringBytes += utf8ByteLength(input);
		if (inputStringBytes > MAX_JSON_TRANSFORM_STRING_BYTES) {
			refuse("input-bytes", "Refusing a JSON transformation above the cumulative input string-byte limit.");
		}
		const output = fn(input);
		if (typeof output !== "string" || !isWellFormedUtf16(output)) {
			refuse("output-text", "Refusing an ill-formed string produced by a JSON transformation.");
		}
		outputStringBytes += utf8ByteLength(output);
		if (outputStringBytes > MAX_JSON_TRANSFORM_STRING_BYTES) {
			refuse("output-bytes", "Refusing a JSON transformation above the cumulative output string-byte limit.");
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
				if (memoEntry === undefined) refuse("internal", "JSON transformation memo state was lost.");
				memoEntry.status = "done";
				memoEntry.result = result;
				continue;
			}

			const seenKeys = new Set<string>();
			for (let index = 0; index < frame.keys.length; index++) {
				const mappedKey = frame.mappedKeys[index];
				if (seenKeys.has(mappedKey)) {
					refuse("key-collision", "Refusing to rewrite two JSON object fields as the same protected key.");
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
			if (memoEntry === undefined) refuse("internal", "JSON transformation memo state was lost.");
			memoEntry.status = "done";
			memoEntry.result = result;
			continue;
		}

		const current = event.value;
		if (typeof current === "string") {
			if (++visitedNodes > MAX_JSON_TRANSFORM_NODES) {
				refuse("nodes", "Refusing a JSON transformation above the node limit.");
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
				refuse("nodes", "Refusing a JSON transformation above the node limit.");
			}
			assign(event.target, current);
			continue;
		}
		if (typeof current !== "object") {
			refuse("non-json-value", "Refusing a non-JSON value in secret transformation data.");
		}
		if (event.depth > MAX_JSON_TRANSFORM_DEPTH) {
			refuse("depth", "Refusing a JSON transformation above the depth limit.");
		}
		const existingMemo = memo.get(current);
		if (existingMemo?.status === "visiting") {
			refuse("cycle", "Refusing a cyclic JSON transformation graph.");
		}
		if (existingMemo?.status === "done") {
			assign(event.target, existingMemo.result);
			continue;
		}
		if (++visitedNodes > MAX_JSON_TRANSFORM_NODES) {
			refuse("nodes", "Refusing a JSON transformation above the node limit.");
		}

		const isArray = Array.isArray(current);
		const prototype = Object.getPrototypeOf(current);
		if (!isArray && prototype !== Object.prototype && prototype !== null) {
			refuse("non-plain-object", "Refusing a non-plain object in JSON transformation data.");
		}
		const keys: string[] = [];
		const sourceValues: unknown[] = [];
		if (isArray) {
			if (current.length > MAX_JSON_TRANSFORM_NODES - visitedNodes) {
				refuse("array-items", "Refusing a JSON transformation above the array-item limit.");
			}
			for (let index = 0; index < current.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
				if (descriptor !== undefined && !("value" in descriptor)) {
					refuse("accessor", "Refusing an accessor property in JSON transformation data.");
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
				refuse("symbol-key", "Refusing an enumerable symbol key in JSON transformation data.");
			}
			for (const key in record) {
				if (!Object.hasOwn(record, key)) continue;
				if (++visitedKeys > MAX_JSON_TRANSFORM_KEYS) {
					refuse("keys", "Refusing a JSON transformation above the object-key limit.");
				}
				const descriptor = Object.getOwnPropertyDescriptor(record, key);
				if (descriptor === undefined || !("value" in descriptor)) {
					refuse("accessor", "Refusing an accessor property in JSON transformation data.");
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
