// The walker's own module, not `./secrets/obfuscator`, which re-exports it. This file is the final
// seam every outbound request passes through, so it is on the graph of everything that can make one:
// through the obfuscator it also pulled in the secret registry and 18 modules of JSON Schema
// validator, 24 modules for one function, and `tools/read.ts` was over its reach ceiling by exactly
// that. See `test/architecture/leveraged-imports-stay-cut.test.ts`.
import { JsonTransformError, type JsonTransformFailureCode, mapJsonStrings } from "./json-transform";

/** A live final-seam transform for text leaving the veyyon process. */
export type ProviderTextTransform = (text: string) => string;

/** Resolve the transform again for each physical outbound attempt. */
export type ProviderTextTransformResolver = () => ProviderTextTransform | undefined;

/** Payload-independent causes that can safely cross a confidentiality boundary. */
export type ProviderTransformFailureCode =
	| JsonTransformFailureCode
	| "resolver-threw"
	| "transform-output"
	| "transform-threw";

export interface ProviderPayloadTransformOptions {
	/** Include a closed, payload-independent reason in the operator-facing error. */
	safeFailureDetails?: boolean;
}

const SAFE_FAILURE_DETAILS: Record<ProviderTransformFailureCode, string> = {
	accessor: "the provider request contains an accessor property",
	"array-items": "the provider request exceeds the confidentiality scan array limit",
	cycle: "the provider request contains a cycle",
	depth: "the provider request exceeds the confidentiality scan depth limit",
	"input-bytes": "the provider request exceeds the confidentiality scan byte limit",
	"input-utf16": "the provider request contains invalid text",
	internal: "the confidentiality scan reached an invalid internal state",
	"key-collision": "two provider request keys collide after secret protection",
	keys: "the provider request exceeds the confidentiality scan key limit",
	nodes: "the provider request exceeds the confidentiality scan node limit",
	"non-json-value": "the provider request contains a non-JSON value",
	"non-plain-object": "the provider request contains a non-JSON object",
	"output-bytes": "secret protection expands the request beyond the confidentiality scan byte limit",
	"output-text": "secret protection produced invalid text",
	"resolver-threw": "the live secret-protection transform could not be resolved",
	"symbol-key": "the provider request contains an enumerable symbol key",
	"transform-output": "the live secret-protection transform returned a non-string value",
	"transform-threw": "the live secret-protection transform raised an internal error",
};

/** A fail-closed transform refusal whose code and message never contain payload data. */
export class ProviderTransformError extends Error {
	constructor(
		boundary: string,
		readonly code: ProviderTransformFailureCode,
		includeSafeDetail = false,
	) {
		super(
			includeSafeDetail
				? `${boundary}: ${SAFE_FAILURE_DETAILS[code]}; confidentiality transform failed.`
				: `${boundary} confidentiality transform failed.`,
		);
		this.name = "ProviderTransformError";
	}
}

const identityProviderTextTransform: ProviderTextTransform = text => text;

function confidentialityTransformError(
	boundary: string,
	code: ProviderTransformFailureCode,
	includeSafeDetail = false,
): ProviderTransformError {
	return new ProviderTransformError(boundary, code, includeSafeDetail);
}

/**
 * Resolve a live transform and wrap it so transform diagnostics can never echo
 * the provider-bound source text that caused the failure.
 */
export function resolveProviderTextTransform(
	resolveTransform: ProviderTextTransformResolver | undefined,
	boundary: string,
): ProviderTextTransform {
	let transform: ProviderTextTransform;
	try {
		transform = resolveTransform?.() ?? identityProviderTextTransform;
	} catch {
		throw confidentialityTransformError(boundary, "resolver-threw");
	}

	return (text: string): string => {
		try {
			const transformed = transform(text);
			if (typeof transformed !== "string") {
				throw confidentialityTransformError(boundary, "transform-output");
			}
			return transformed;
		} catch (error) {
			if (error instanceof ProviderTransformError) throw error;
			throw confidentialityTransformError(boundary, "transform-threw");
		}
	};
}

/**
 * Clone a JSON-shaped payload while transforming every string value and object
 * key. The raw input remains untouched so a retry can use the then-current
 * transform instead of a stale serialized snapshot.
 */
export function transformProviderPayload(
	value: unknown,
	transform: ProviderTextTransform,
	boundary: string,
	options?: ProviderPayloadTransformOptions,
): unknown {
	try {
		return mapJsonStrings(value, transform);
	} catch (error) {
		const code = error instanceof JsonTransformError ? error.code : "transform-threw";
		throw confidentialityTransformError(boundary, code, options?.safeFailureDetails);
	}
}
