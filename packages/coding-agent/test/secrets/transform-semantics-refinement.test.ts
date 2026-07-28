import { describe, expect, it } from "bun:test";
import type { Context } from "@veyyon/ai";
import {
	obfuscateProviderContext,
	type SecretEntry,
	SecretObfuscator,
} from "@veyyon/coding-agent/secrets/obfuscator";
import { buildValuePlaceholder } from "@veyyon/coding-agent/secrets/placeholder";

const KEY = new Uint8Array(32).fill(91);

describe("literal transform precedence", () => {
	/** Overlapping values must use leftmost-longest selection and still reverse byte-for-byte. */
	it("round-trips the longest literal at a shared start", () => {
		const short = "secret-value";
		const long = `long-${short}`;
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: short },
				{ type: "plain", content: long },
			],
			{ placeholderKey: KEY },
		);
		const expected = buildValuePlaceholder(long, KEY);

		const protectedText = obfuscator.obfuscate(`${long} / ${short}`);

		expect(protectedText).toBe(`${expected} / ${buildValuePlaceholder(short, KEY)}`);
		expect(obfuscator.deobfuscate(protectedText)).toBe(`${long} / ${short}`);
	});

	/** A refreshed exact replace policy must beat retained historical redaction for that same source. */
	it("does not let a retained tombstone override the active replacement", () => {
		const value = "policy-updated-secret-value";
		const previous = new SecretObfuscator([{ type: "plain", content: value }], { placeholderKey: KEY });
		const current = new SecretObfuscator(
			[{ type: "plain", content: value, mode: "replace", replacement: "MASKED_VALUE" }],
			{ placeholderKey: KEY },
		);

		current.retainRedactionsFrom(previous);

		expect(current.obfuscate(value)).toBe("MASKED_VALUE");
	});
});


describe("direct declaration invariants", () => {
	/** One readable name cannot deterministically mean two values in the same registry. */
	it("refuses duplicate names with different values", () => {
		expect(
			() =>
				new SecretObfuscator(
					[
						{ type: "plain", content: "first-duplicate-secret", name: "DUPLICATE_NAME" },
						{ type: "plain", content: "second-duplicate-secret", name: "DUPLICATE_NAME" },
					],
					{ placeholderKey: KEY },
				),
		).toThrow(/conflicting declarations.*same secret name/i);
	});

	/** Duplicate lifetimes for one name are order-dependent authority and must not use last-entry-wins. */
	it("refuses duplicate names with conflicting expiry", () => {
		expect(
			() =>
				new SecretObfuscator(
					[
						{ type: "plain", content: "same-duplicate-secret", name: "DUPLICATE_NAME", expiresAt: 10 },
						{ type: "plain", content: "same-duplicate-secret", name: "DUPLICATE_NAME", expiresAt: 20 },
					],
					{ placeholderKey: KEY },
				),
		).toThrow(/conflicting declarations.*same secret name/i);
	});

	/** Programmatic callers must not get silent acceptance of fields that the selected transform never uses. */
	it.each([
		[{ type: "plain", content: "unused-field-secret", replacement: "ignored" }, /replacement.*replace.*mode/i],
		[{ type: "plain", content: "unused-field-secret", flags: "i" }, /flags.*plain secret/i],
		[{ type: "plain", content: "unused-field-secret", minLength: 4 }, /minLength.*no reversible regex/i],
		[
			{ type: "regex", content: "token-[0-9]+", mode: "replace", minLength: 4 },
			/minLength.*no reversible regex/i,
		],
		[{ type: "regex", content: "token-[0-9]+", minLength: 0 }, /minLength.*whole number/i],
		[{ type: "regex", content: "token-[0-9]+", name: "REGEX_TOKEN" }, /name.*reversible plain/i],
		[{ type: "regex", content: "token-[0-9]+", expiresAt: 10 }, /expiry.*reversible plain/i],
	] as Array<[SecretEntry, RegExp]>)('refuses ignored declaration fields for "$type" entries', (entry, message) => {
		expect(() => new SecretObfuscator([entry], { placeholderKey: KEY })).toThrow(message);
	});
});

describe("copy-on-change provider transforms", () => {
	/** A no-op provider boundary is a hot path and must preserve the complete context identity. */
	it("returns the original provider context when no string changes", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "configured-secret-value" }], {
			placeholderKey: KEY,
		});
		const context: Context = { systemPrompt: ["safe prompt"], messages: [], tools: [] };

		expect(obfuscateProviderContext(obfuscator, context)).toBe(context);
	});
});
