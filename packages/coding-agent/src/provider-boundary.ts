// The walker's own module, not `./secrets/obfuscator`, which re-exports it. This file is the final seam every outbound request passes through, so it is on the graph of everything that can make one:
import { JsonTransformError, mapJsonStrings } from "./json-transform";
import type {
	ProviderPayloadTransformOptions,
	ProviderTextTransform,
	ProviderTextTransformResolver,
	ProviderTransformFailureCode,
} from "./provider-boundary-helpers";
import { SAFE_FAILURE_DETAILS } from "./provider-boundary-helpers";

export type { ProviderTextTransformResolver };

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

/** Resolve a live transform and wrap it so transform diagnostics can never echo the provider-bound source text that caused the failure. */
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

/** Clone a JSON-shaped payload while transforming every string value and object key. The raw input remains untouched so a retry can use the then-current */
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
