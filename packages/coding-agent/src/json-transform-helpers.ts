export type JsonWithOptionalFields =
	| string
	| number
	| boolean
	| null
	| JsonWithOptionalFields[]
	| { [key: string]: JsonWithOptionalFields | undefined };

export type JsonRecord = { [key: string]: JsonWithOptionalFields | undefined };

export const MAX_JSON_TRANSFORM_DEPTH = 128;
export const MAX_JSON_TRANSFORM_NODES = 100_000;
export const MAX_JSON_TRANSFORM_KEYS = 100_000;
export const MAX_JSON_TRANSFORM_STRING_BYTES = 16 * 1024 * 1024;

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
