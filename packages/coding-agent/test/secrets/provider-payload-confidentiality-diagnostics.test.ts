import { describe, expect, it } from "bun:test";
import { ProviderTransformError, transformProviderPayload } from "@veyyon/coding-agent/provider-boundary";
import { MAX_JSON_TRANSFORM_DEPTH } from "@veyyon/coding-agent/secrets/obfuscator";

const BOUNDARY = "AgentSession provider payload";
const RAW_SECRET = "SYNTHETIC_DIAGNOSTIC_SECRET";

function diagnosticFailure(value: unknown, transform: (text: string) => string = text => text): ProviderTransformError {
	try {
		transformProviderPayload(value, transform, BOUNDARY, { safeFailureDetails: true });
	} catch (error) {
		if (error instanceof ProviderTransformError) return error;
		throw error;
	}
	throw new Error("Expected the confidentiality transform to reject the synthetic payload.");
}

function expectSecretIndependent(error: ProviderTransformError): void {
	expect(error.message).not.toContain(RAW_SECRET);
	expect(error.message).not.toContain("#DIAGNOSTIC_TOKEN#");
}

describe("provider payload confidentiality diagnostics", () => {
	/**
	 * A valid payload must remain lossless apart from the requested string and key
	 * protection, so adding diagnostics cannot become a second serialization path.
	 */
	it("preserves valid payload semantics while safe diagnostics are enabled", () => {
		const input = { [RAW_SECRET]: { value: RAW_SECRET }, count: 2 };
		const output = transformProviderPayload(
			input,
			text => text.replaceAll(RAW_SECRET, "#DIAGNOSTIC_TOKEN#"),
			BOUNDARY,
			{ safeFailureDetails: true },
		) as Record<string, unknown>;

		expect(output).toEqual({ "#DIAGNOSTIC_TOKEN#": { value: "#DIAGNOSTIC_TOKEN#" }, count: 2 });
		expect(input).toEqual({ [RAW_SECRET]: { value: RAW_SECRET }, count: 2 });
	});

	/**
	 * Redaction can collapse a raw credential key onto an existing placeholder.
	 * The request must fail closed and name only that structural category.
	 */
	it("identifies transformed-key collisions without exposing either key", () => {
		const error = diagnosticFailure({ [RAW_SECRET]: "raw", "#DIAGNOSTIC_TOKEN#": "protected" }, text =>
			text.replaceAll(RAW_SECRET, "#DIAGNOSTIC_TOKEN#"),
		);

		expect(error.code).toBe("key-collision");
		expect(error.message).toBe(
			"AgentSession provider payload: two provider request keys collide after secret protection; confidentiality transform failed.",
		);
		expectSecretIndependent(error);
	});

	/**
	 * Provider SDKs can accidentally retain a cyclic request graph. The refusal
	 * must distinguish that provider-shaping bug without traversing or printing it.
	 */
	it("identifies cyclic provider requests without serializing them", () => {
		const payload: Record<string, unknown> = { value: RAW_SECRET };
		payload.self = payload;
		const error = diagnosticFailure(payload);

		expect(error.code).toBe("cycle");
		expect(error.message).toContain("the provider request contains a cycle");
		expectSecretIndependent(error);
	});

	/**
	 * A class instance is not JSON even when it has enumerable fields. Naming the
	 * category tells the operator this is provider shaping, not a rejected secret.
	 */
	it("identifies non-plain provider request objects", () => {
		const error = diagnosticFailure({ when: new Date(0), value: RAW_SECRET });

		expect(error.code).toBe("non-plain-object");
		expect(error.message).toContain("the provider request contains a non-JSON object");
		expectSecretIndependent(error);
	});

	/**
	 * BigInt and other non-JSON primitives cannot be sent by JSON providers. The
	 * transform must refuse before fetch and report the safe primitive category.
	 */
	it("identifies non-JSON primitive values", () => {
		const error = diagnosticFailure({ value: 1n, secret: RAW_SECRET });

		expect(error.code).toBe("non-json-value");
		expect(error.message).toContain("the provider request contains a non-JSON value");
		expectSecretIndependent(error);
	});

	/**
	 * Accessors may execute arbitrary secret-bearing code. Inspection must use the
	 * descriptor, leave the getter untouched, and expose only the accessor category.
	 */
	it("identifies accessors without invoking their getters", () => {
		let getterCalls = 0;
		const payload: Record<string, unknown> = {};
		Object.defineProperty(payload, "value", {
			enumerable: true,
			get() {
				getterCalls++;
				throw new Error(RAW_SECRET);
			},
		});
		const error = diagnosticFailure(payload);

		expect(error.code).toBe("accessor");
		expect(getterCalls).toBe(0);
		expectSecretIndependent(error);
	});

	/**
	 * A provider request beyond the bounded walk depth is an actionable size/shape
	 * problem. The category must survive without including any generated key.
	 */
	it("identifies requests beyond the confidentiality depth bound", () => {
		const root: Record<string, unknown> = {};
		let cursor = root;
		for (let depth = 0; depth <= MAX_JSON_TRANSFORM_DEPTH + 1; depth++) {
			const child: Record<string, unknown> = {};
			cursor[`${RAW_SECRET}-${depth}`] = child;
			cursor = child;
		}
		const error = diagnosticFailure(root);

		expect(error.code).toBe("depth");
		expect(error.message).toContain("the provider request exceeds the confidentiality scan depth limit");
		expectSecretIndependent(error);
	});

	/**
	 * Secret protection itself can reject a string. Its exception may contain the
	 * input, so the boundary must replace it with the closed transform category.
	 */
	it("identifies transform exceptions without forwarding their message", () => {
		const error = diagnosticFailure({ value: RAW_SECRET }, () => {
			throw new Error(`failed while protecting ${RAW_SECRET}`);
		});

		expect(error.code).toBe("transform-threw");
		expect(error.message).toContain("the live secret-protection transform raised an internal error");
		expectSecretIndependent(error);
	});

	/**
	 * Existing non-AgentSession boundaries intentionally retain their compact
	 * payload-independent message until their own operator surfaces consume codes.
	 */
	it("retains the generic message when safe details are not requested", () => {
		const payload: Record<string, unknown> = { value: RAW_SECRET };
		payload.self = payload;
		let failure: ProviderTransformError | undefined;
		try {
			transformProviderPayload(payload, text => text, "MCP tool call");
		} catch (error) {
			if (error instanceof ProviderTransformError) failure = error;
			else throw error;
		}

		expect(failure?.code).toBe("cycle");
		expect(failure?.message).toBe("MCP tool call confidentiality transform failed.");
		expect(failure?.message).not.toContain(RAW_SECRET);
	});
});
