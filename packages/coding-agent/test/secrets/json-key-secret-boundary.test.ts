import { describe, expect, it } from "bun:test";
import type { Context } from "@veyyon/ai";
import {
	mapJsonStrings,
	obfuscateProviderContext,
	obfuscateToolArguments,
	SecretObfuscator,
} from "@veyyon/coding-agent/secrets/obfuscator";
import { type } from "arktype";

const PLACEHOLDER_KEY = new Uint8Array(32).fill(11);
const SECRET = "credential-in-json-key";

function reversibleObfuscator(): SecretObfuscator {
	return new SecretObfuscator(
		[{ type: "plain", content: SECRET, mode: "obfuscate", name: "JSON_KEY_SECRET" }],
		{ placeholderKey: PLACEHOLDER_KEY },
	);
}

describe("JSON object keys share the secret boundary with values", () => {
	/**
	 * Tool arguments are serialized with their property names. A credential in a property name is
	 * provider-visible even when every property value has already been redacted.
	 */
	it("obfuscates and restores a secret embedded in a tool-argument key", () => {
		const obfuscator = reversibleObfuscator();
		const original = { [`header-${SECRET}`]: "safe-value" };

		const outbound = obfuscateToolArguments(obfuscator, original);
		expect(Object.keys(outbound)).toEqual(["header-#JSON_KEY_SECRET#"]);
		expect(outbound).toEqual({ "header-#JSON_KEY_SECRET#": "safe-value" });

		const restored = mapJsonStrings(outbound, value => obfuscator.deobfuscate(value));
		expect(restored).toEqual(original);
	});

	/**
	 * Provider schemas and replay payloads nest objects beneath arrays. The recursive walk must
	 * protect keys at every depth rather than only the first object passed to it.
	 */
	it("obfuscates nested keys beneath arrays", () => {
		const obfuscator = reversibleObfuscator();
		const original = { items: [{ properties: { [SECRET]: { type: "string" } } }] };

		const outbound = mapJsonStrings(original, value => obfuscator.obfuscate(value));
		expect(outbound as unknown).toEqual({
			items: [{ properties: { "#JSON_KEY_SECRET#": { type: "string" } } }],
		});
		expect(mapJsonStrings(outbound, value => obfuscator.deobfuscate(value))).toEqual(original);
	});

	/**
	 * Two distinct input fields can collapse to one key under replace mode. Silently overwriting a
	 * field changes tool semantics, while naming the original key in the error can leak the secret.
	 */
	it("fails closed when rewritten keys collide", () => {
		const obfuscator = new SecretObfuscator(
			[
				{
					type: "plain",
					content: "replacement-source-key",
					mode: "replace",
					replacement: "safe",
				},
			],
			{ placeholderKey: PLACEHOLDER_KEY },
		);
		const original = { "replacement-source-key": 1, safe: 2 };

		let collisionError: unknown;
		try {
			mapJsonStrings(original, value => obfuscator.obfuscate(value));
		} catch (error) {
			collisionError = error;
		}
		expect(collisionError).toBeInstanceOf(Error);
		const message = (collisionError as Error).message;
		expect(message).toContain("rewrite two JSON object fields as the same protected key");
		expect(message).not.toContain("replacement-source-key");
		expect(original).toEqual({ "replacement-source-key": 1, safe: 2 });
	});

	/**
	 * An unchanged JSON tree stays referentially identical. Provider dispatch is a hot path, and
	 * protecting keys must not force a deep copy when no credential occurs.
	 */
	it("preserves unchanged object and array references", () => {
		const child = { ordinary: "value" };
		const original = { nested: [child] };
		const obfuscator = reversibleObfuscator();

		const mapped = mapJsonStrings(original, value => obfuscator.obfuscate(value));
		expect(mapped).toBe(original);
		expect(mapped.nested).toBe(original.nested);
		expect(mapped.nested[0]).toBe(child);
	});

	/**
	 * JSON may legally contain an own `__proto__` field. Rebuilding a changed object must define it
	 * as data instead of invoking the legacy prototype setter and mutating the output prototype.
	 */
	it("preserves an own __proto__ key without prototype mutation", () => {
		const obfuscator = reversibleObfuscator();
		const original = JSON.parse(`{"__proto__":"${SECRET}","ordinary":"value"}`) as Record<string, unknown>;

		const outbound = mapJsonStrings(original, value => obfuscator.obfuscate(value));
		expect(Object.hasOwn(outbound, "__proto__")).toBe(true);
		expect(outbound.__proto__).toBe("#JSON_KEY_SECRET#");
		expect(Object.getPrototypeOf(outbound)).toBe(Object.prototype);
	});

	/**
	 * Replacement mode remains one-way for keys: an outbound alias is never interpreted as a
	 * reversible credential when provider output is restored locally.
	 */
	it("keeps replace-mode keys one-way", () => {
		const obfuscator = new SecretObfuscator(
			[{ type: "plain", content: "replacement-source-key", mode: "replace", replacement: "alias" }],
			{ placeholderKey: PLACEHOLDER_KEY },
		);
		const outbound = mapJsonStrings({ "replacement-source-key": true }, value => obfuscator.obfuscate(value));

		expect(outbound as unknown).toEqual({ alias: true });
		expect(mapJsonStrings(outbound, value => obfuscator.deobfuscate(value)) as unknown).toEqual({ alias: true });
	});

	/**
	 * Tool schemas are converted to their wire JSON immediately before dispatch. This end-to-end
	 * case proves a secret property name cannot survive that conversion as a provider-visible key.
	 */
	it("protects dynamic property names in provider-bound tool schemas", () => {
		const obfuscator = reversibleObfuscator();
		const context: Context = {
			messages: [],
			tools: [
				{
					name: "dynamic_schema",
					description: "Schema with an operator-provided field name",
					parameters: type({ [SECRET]: "string" }),
				},
			],
		};

		const outbound = obfuscateProviderContext(obfuscator, context);
		const encoded = JSON.stringify(outbound.tools?.[0]?.parameters);
		expect(encoded).not.toContain(SECRET);
		expect(encoded).toContain("#JSON_KEY_SECRET#");
		expect(JSON.stringify(context.tools?.[0]?.parameters)).toContain(SECRET);
	});
});
