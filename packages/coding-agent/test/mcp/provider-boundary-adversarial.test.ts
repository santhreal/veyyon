import { describe, expect, it } from "bun:test";
import { transformProviderPayload } from "@veyyon/coding-agent/provider-boundary";
import {
	MAX_JSON_TRANSFORM_DEPTH,
	MAX_JSON_TRANSFORM_STRING_BYTES,
} from "@veyyon/coding-agent/secrets/obfuscator";

const MCP_BOUNDARY = "MCP tool call";
const GENERIC_FAILURE = "MCP tool call confidentiality transform failed.";

function expectGenericBoundaryFailure(value: unknown, transform: (text: string) => string = text => text): void {
	expect(() => transformProviderPayload(value, transform, MCP_BOUNDARY)).toThrow(GENERIC_FAILURE);
}

describe("provider-boundary bounded JSON adversarial inputs", () => {
	it("rejects an over-depth graph iteratively without exposing graph strings", () => {
		const root: Record<string, unknown> = {};
		let cursor = root;
		for (let depth = 0; depth <= MAX_JSON_TRANSFORM_DEPTH + 1; depth++) {
			const child: Record<string, unknown> = {};
			cursor[`secret-depth-${depth}`] = child;
			cursor = child;
		}

		expectGenericBoundaryFailure(root);
	});

	it("rejects cycles instead of serializing or retaining a cyclic outbound payload", () => {
		const rawSecret = "CYCLIC_PROVIDER_SECRET";
		const payload: Record<string, unknown> = { value: rawSecret };
		payload.self = payload;

		expectGenericBoundaryFailure(payload, text => text.replaceAll(rawSecret, "safe"));
	});

	it("rejects accessor properties without invoking their secret-bearing getter", () => {
		const rawSecret = "ACCESSOR_PROVIDER_SECRET";
		let getterCalls = 0;
		const payload: Record<string, unknown> = {};
		Object.defineProperty(payload, "secret", {
			enumerable: true,
			get() {
				getterCalls++;
				throw new Error(rawSecret);
			},
		});

		expectGenericBoundaryFailure(payload);
		expect(getterCalls).toBe(0);
	});

	it("wraps hostile proxy traps with the same non-reflective failure", () => {
		const rawSecret = "PROXY_PROVIDER_SECRET";
		const payload = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error(rawSecret);
				},
			},
		);

		expectGenericBoundaryFailure(payload);
	});

	it("rejects transformed-key collisions rather than silently dropping a field", () => {
		const payload = { firstSecret: "one", secondSecret: "two" };

		expectGenericBoundaryFailure(payload, text =>
			text === "firstSecret" || text === "secondSecret" ? "protected" : text,
		);
	});

	it("rejects cumulative transformed strings above the canonical byte limit", () => {
		const oversized = "x".repeat(MAX_JSON_TRANSFORM_STRING_BYTES + 1);

		expectGenericBoundaryFailure({ value: "expand-me" }, text =>
			text === "expand-me" ? oversized : text,
		);
	});

	it("maps a valid shared DAG once, preserves sharing, and leaves the raw graph untouched", () => {
		const rawSecret = "SHARED_DAG_PROVIDER_SECRET";
		const shared = { token: rawSecret };
		const raw = { left: shared, right: shared };

		const transformed = transformProviderPayload(
			raw,
			text => text.replaceAll(rawSecret, "[SAFE_DAG]"),
			MCP_BOUNDARY,
		) as { left: { token: string }; right: { token: string } };

		expect(transformed).not.toBe(raw);
		expect(transformed.left).toBe(transformed.right);
		expect(transformed.left.token).toBe("[SAFE_DAG]");
		expect(raw.left).toBe(shared);
		expect(shared.token).toBe(rawSecret);
	});
});
