// The walker's own module, not `./secrets/obfuscator`, which re-exports it. This file is the final
// seam every outbound request passes through, so it is on the graph of everything that can make one:
// through the obfuscator it also pulled in the secret registry and 18 modules of JSON Schema
// validator, 24 modules for one function, and `tools/read.ts` was over its reach ceiling by exactly
// that. See `test/architecture/leveraged-imports-stay-cut.test.ts`.
import { mapJsonStrings } from "./json-transform";

/** A live final-seam transform for text leaving the veyyon process. */
export type ProviderTextTransform = (text: string) => string;

/** Resolve the transform again for each physical outbound attempt. */
export type ProviderTextTransformResolver = () => ProviderTextTransform | undefined;

const identityProviderTextTransform: ProviderTextTransform = text => text;

function confidentialityTransformError(boundary: string): Error {
	return new Error(`${boundary} confidentiality transform failed.`);
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
		throw confidentialityTransformError(boundary);
	}

	return (text: string): string => {
		try {
			const transformed = transform(text);
			if (typeof transformed !== "string") throw confidentialityTransformError(boundary);
			return transformed;
		} catch {
			throw confidentialityTransformError(boundary);
		}
	};
}

/**
 * Clone a JSON-shaped payload while transforming every string value and object
 * key. The raw input remains untouched so a retry can use the then-current
 * transform instead of a stale serialized snapshot.
 */
export function transformProviderPayload(value: unknown, transform: ProviderTextTransform, boundary: string): unknown {
	try {
		return mapJsonStrings(value, transform);
	} catch {
		throw confidentialityTransformError(boundary);
	}
}
