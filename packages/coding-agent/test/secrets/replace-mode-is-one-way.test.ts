import { describe, expect, it } from "bun:test";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";

const PLACEHOLDER_KEY = new Uint8Array(32).fill(7);

describe("replace mode is permanently one-way", () => {
	/**
	 * A custom replacement must not be a named placeholder, or an echoed replacement expands
	 * into a different live credential and turns a redaction rule into a credential capability.
	 */
	it("rejects a replacement equal to a named secret placeholder", () => {
		expect(
			() =>
				new SecretObfuscator(
					[
						{
							type: "plain",
							content: "replacement-source-secret",
							mode: "replace",
							replacement: "#TARGET_SECRET#",
						},
						{
							type: "plain",
							content: "target-live-credential",
							mode: "obfuscate",
							name: "TARGET_SECRET",
						},
					],
					{ placeholderKey: PLACEHOLDER_KEY },
				),
		).toThrow("contains a reversible secret placeholder");
	});

	/**
	 * Hiding a placeholder inside otherwise ordinary replacement prose is the same escalation.
	 * Validation therefore scans the whole replacement rather than checking only exact equality.
	 */
	it("rejects an embedded named placeholder", () => {
		expect(
			() =>
				new SecretObfuscator(
					[
						{
							type: "plain",
							content: "replacement-source-secret",
							mode: "replace",
							replacement: "redacted as #TARGET_SECRET# for transport",
						},
					],
					{ placeholderKey: PLACEHOLDER_KEY },
				),
		).toThrow("contains a reversible secret placeholder");
	});

	/**
	 * Opaque HMAC-shaped placeholders are reversible too. Blocking only readable names would
	 * leave unnamed credentials reachable through a custom replacement.
	 */
	it("rejects an opaque value-placeholder shape", () => {
		const opaquePlaceholder = `#0${"A".repeat(24)}#`;
		expect(
			() =>
				new SecretObfuscator(
					[
						{
							type: "plain",
							content: "replacement-source-secret",
							mode: "replace",
							replacement: opaquePlaceholder,
						},
					],
					{ placeholderKey: PLACEHOLDER_KEY },
				),
		).toThrow("contains a reversible secret placeholder");
	});

	/**
	 * Regex declarations are loaded before they match input. An unsafe replacement must fail at
	 * construction instead of waiting for attacker-controlled text to activate the escalation.
	 */
	it("rejects an unsafe regex replacement when configuration loads", () => {
		expect(
			() =>
				new SecretObfuscator(
					[
						{
							type: "regex",
							content: "token-[A-Z]{8}",
							mode: "replace",
							replacement: "#TARGET_SECRET#",
						},
					],
					{ placeholderKey: PLACEHOLDER_KEY },
				),
		).toThrow("contains a reversible secret placeholder");
	});

	/**
	 * Hash-marked prose outside the placeholder grammar remains usable, so the security check does
	 * not ban ordinary replacement labels that can never be expanded by deobfuscation.
	 */
	it("allows non-placeholder hash prose and never expands it", () => {
		const obfuscator = new SecretObfuscator(
			[
				{
					type: "plain",
					content: "replacement-source-secret",
					mode: "replace",
					replacement: "redacted #lowercase# value",
				},
			],
			{ placeholderKey: PLACEHOLDER_KEY },
		);

		const outbound = obfuscator.obfuscate("use replacement-source-secret");
		expect(outbound).toBe("use redacted #lowercase# value");
		expect(obfuscator.deobfuscate(outbound)).toBe(outbound);
	});

	/**
	 * Generated replacements contain no placeholder delimiters and survive an inbound pass exactly,
	 * proving the default replace path remains one-way without custom configuration.
	 */
	it("keeps generated replacements one-way", () => {
		const obfuscator = new SecretObfuscator(
			[{ type: "plain", content: "replacement-source-secret", mode: "replace" }],
			{ placeholderKey: PLACEHOLDER_KEY },
		);

		const outbound = obfuscator.obfuscate("replacement-source-secret");
		expect(outbound).not.toBe("replacement-source-secret");
		expect(outbound).not.toContain("#");
		expect(obfuscator.deobfuscate(outbound)).toBe(outbound);
	});

	/**
	 * Generated aliases are a keyed PRF output. A provider that guesses a low-entropy credential
	 * must not be able to reproduce the observed alias without the machine-local vault key.
	 */
	it("does not expose a cross-machine dictionary oracle", () => {
		const first = new SecretObfuscator(
			[{ type: "plain", content: "12345678", mode: "replace" }],
			{ placeholderKey: new Uint8Array(32).fill(1) },
		);
		const second = new SecretObfuscator(
			[{ type: "plain", content: "12345678", mode: "replace" }],
			{ placeholderKey: new Uint8Array(32).fill(2) },
		);

		expect(first.obfuscate("12345678")).not.toBe(second.obfuscate("12345678"));
	});

	/**
	 * The persisted machine key keeps generated aliases stable across runtime rebuilds. Stability
	 * preserves provider caches without falling back to a public, provider-verifiable hash.
	 */
	it("keeps aliases stable for the same machine key", () => {
		const first = new SecretObfuscator(
			[{ type: "plain", content: "stable-replacement-secret", mode: "replace" }],
			{ placeholderKey: PLACEHOLDER_KEY },
		);
		const second = new SecretObfuscator(
			[{ type: "plain", content: "stable-replacement-secret", mode: "replace" }],
			{ placeholderKey: PLACEHOLDER_KEY },
		);

		expect(first.obfuscate("stable-replacement-secret")).toBe(second.obfuscate("stable-replacement-secret"));
	});

	/**
	 * Counter-mode HMAC must cover values longer than one digest instead of repeating or padding a
	 * short public hash. The alias keeps the exact transport length and remains fully derived.
	 */
	it("generates the full alias for values longer than one digest", () => {
		const secret = "long-secret-segment-".repeat(12);
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret, mode: "replace" }], {
			placeholderKey: PLACEHOLDER_KEY,
		});

		const outbound = obfuscator.obfuscate(secret);
		expect(outbound).toHaveLength(secret.length);
		expect(outbound).not.toBe(secret);
		expect(outbound).toMatch(/^[A-Za-z0-9]+$/);
	});

	/**
	 * Runtime regex matches use the same keyed derivation as literal rules. Otherwise an attacker
	 * could bypass the fix by placing a guessed credential behind a replace-mode pattern.
	 */
	it("keys generated regex replacements", () => {
		const entry = { type: "regex" as const, content: "pin-[0-9]{8}", mode: "replace" as const };
		const first = new SecretObfuscator([entry], { placeholderKey: new Uint8Array(32).fill(3) });
		const second = new SecretObfuscator([entry], { placeholderKey: new Uint8Array(32).fill(4) });

		expect(first.obfuscate("pin-12345678")).not.toBe(second.obfuscate("pin-12345678"));
	});

	/**
	 * An empty literal cannot consume bytes, so accepting it reports an active protection rule that
	 * can never redact anything. Configuration loading rejects that silent no-op immediately.
	 */
	it("rejects an empty literal replacement", () => {
		expect(
			() =>
				new SecretObfuscator([{ type: "plain", content: "", mode: "replace" }], {
					placeholderKey: PLACEHOLDER_KEY,
				}),
		).toThrow("Refusing an empty plain secret");
	});

	/**
	 * Hash-marked uppercase text outside both live placeholder grammars is inert. Keeping it legal
	 * avoids rejecting existing redaction labels that deobfuscation can never expand.
	 */
	it("allows inert uppercase hash labels outside the placeholder grammar", () => {
		const obfuscator = new SecretObfuscator(
			[
				{
					type: "plain",
					content: "replacement-source-secret",
					mode: "replace",
					replacement: "#ABCD#",
				},
			],
			{ placeholderKey: PLACEHOLDER_KEY },
		);

		expect(obfuscator.obfuscate("replacement-source-secret")).toBe("#ABCD#");
		expect(obfuscator.deobfuscate("#ABCD#")).toBe("#ABCD#");
	});
});
