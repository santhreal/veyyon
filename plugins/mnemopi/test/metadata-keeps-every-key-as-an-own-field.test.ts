/**
 * WHY: metadata normalization assigned each key with `out[key] = value`. For a `__proto__` key
 * that assignment runs the prototype setter, so the record's prototype became the caller's value
 * and the key disappeared from both the normalized record and its serialized JSON.
 *
 * The class: every key `Object.prototype` defines, as an own field of the metadata, at the top
 * level, inside a nested record and inside a record held by an array, through each entry point
 * (`normalizeMetadata` on a JSON string, on a parsed object, `memoryRowMetadata` on a stored
 * row, and `metadataJson`). The key list is read from `Object.prototype` at run time, so a key a
 * newer runtime adds is covered without editing this file.
 *
 * Gap: the cases cover keys inherited from `Object.prototype`. A metadata object built with a
 * custom prototype carrying enumerable inherited keys is normalized through `for...in`, which
 * flattens those keys into own fields; that behavior is not pinned here.
 */
import { describe, expect, it } from "bun:test";
import { memoryRowMetadata, metadataJson, normalizeMetadata } from "@veyyon/mnemopi/core/beam/helpers";

const PROTOTYPE_KEYS = Object.getOwnPropertyNames(Object.prototype);

function metadataWith(key: string): string {
	const value = JSON.stringify({ marker: key });
	return `{${JSON.stringify(key)}:${value},"nested":{${JSON.stringify(key)}:${value}},"list":[{${JSON.stringify(key)}:${value}}]}`;
}

function expectOwnKey(record: unknown, key: string): void {
	expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
	expect(Object.getOwnPropertyDescriptor(record, key)?.value).toEqual({ marker: key });
}

function expectEveryLevel(metadata: Record<string, unknown>, key: string): void {
	expectOwnKey(metadata, key);
	expectOwnKey(metadata.nested, key);
	expectOwnKey(Array.isArray(metadata.list) ? metadata.list[0] : undefined, key);
}

describe("metadata keeps every key as an own field", () => {
	it("covers the keys Object.prototype defines, including __proto__", () => {
		expect(PROTOTYPE_KEYS).toContain("__proto__");
		expect(PROTOTYPE_KEYS).toContain("constructor");
	});

	for (const key of PROTOTYPE_KEYS) {
		it(`keeps ${key} through every entry point`, () => {
			const json = metadataWith(key);

			expectEveryLevel(normalizeMetadata(json), key);
			expectEveryLevel(normalizeMetadata(JSON.parse(json)), key);
			expectEveryLevel(memoryRowMetadata({ metadata_json: json }), key);
			expect(metadataJson(JSON.parse(json))).toBe(JSON.stringify(JSON.parse(json)));
		});
	}
});
