import type { JsonTransformFailureCode } from "./json-transform";

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

export const SAFE_FAILURE_DETAILS: Record<ProviderTransformFailureCode, string> = {
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
