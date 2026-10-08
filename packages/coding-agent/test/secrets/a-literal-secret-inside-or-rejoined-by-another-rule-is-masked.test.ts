/**
 * A literal secret is masked when it sits inside another literal's prefix, or when another
 * rule's replacement rejoins it.
 *
 * WHY THIS SUITE EXISTS. The literal matcher reports a literal that ends inside a longer
 * literal's path only through that path's output link, because the scan never stands on the
 * shorter literal's own node there. Text holding the longer literal's prefix and then diverging
 * from it carries the shorter secret, and a scan that drops the link sends it in the clear.
 * Separately, a regex `replace` rule with an empty replacement deletes its match and protects no
 * span, so the text on either side of it becomes adjacent; a literal split by the deleted match
 * exists only after the regex pass, and only the second plain pass masks it.
 *
 * The class it closes: a configured literal left unmasked because it is reported through the
 * output-link chain (directly or inherited through a failure node) or because it forms only after
 * a regex rule ran.
 *
 * WHAT IT DOES NOT CATCH: a literal that overlaps a non-empty regex replacement is not masked,
 * because a replacement span is protected; this suite does not decide whether that is right.
 */

import { describe, expect, it } from "bun:test";
import { type SecretEntry, SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";

const PLACEHOLDER_KEY = new Uint8Array(32).fill(41);

function plain(name: string, content: string): SecretEntry {
	return { type: "plain", origin: "config", content, mode: "obfuscate", name };
}

function obfuscatorFor(entries: SecretEntry[]): SecretObfuscator {
	return new SecretObfuscator(entries, { placeholderKey: PLACEHOLDER_KEY });
}

describe("a literal secret inside a longer literal's prefix", () => {
	const nonLatinInner = "\u5185\u90e8\u79d8\u5bc6\u306e\u5024\u3067\u3059\u3088";
	/** The inner literal ends where the outer literal's path still continues. */
	const cases: ReadonlyArray<readonly [label: string, outer: string, inner: string]> = [
		["ASCII", "prefix-inner-secret-tail", "inner-secret"],
		["past the root table", `\u524d\u7f6e-${nonLatinInner}-\u5c3e`, nonLatinInner],
	];

	for (const [label, outer, inner] of cases) {
		const innerAt = outer.indexOf(inner);
		const diverged = `${outer.slice(0, innerAt + inner.length)}~diverges`;

		it(`is masked when the text leaves the outer literal right after it (${label})`, () => {
			const obfuscator = obfuscatorFor([plain("OUTER_SECRET", outer), plain("INNER_SECRET", inner)]);
			const text = `start ${diverged} end`;
			const outbound = obfuscator.obfuscate(text);
			expect(outbound).toBe(`start ${outer.slice(0, innerAt)}#INNER_SECRET#~diverges end`);
			expect(obfuscator.deobfuscate(outbound)).toBe(text);
		});

		it(`yields to the outer literal when the whole outer literal is present (${label})`, () => {
			const obfuscator = obfuscatorFor([plain("OUTER_SECRET", outer), plain("INNER_SECRET", inner)]);
			const text = `start ${outer} and ${inner} end`;
			const outbound = obfuscator.obfuscate(text);
			expect(outbound).toBe("start #OUTER_SECRET# and #INNER_SECRET# end");
			expect(obfuscator.deobfuscate(outbound)).toBe(text);
		});
	}

	/**
	 * The outer path's failure node lies on the middle literal's path and completes nothing, so
	 * the outer node's output link is inherited from the middle node's link to the innermost.
	 */
	it("is masked when its output link is inherited through a failure node that completes nothing", () => {
		const obfuscator = obfuscatorFor([
			plain("OUTER_SECRET", "11-22-33-44-55-outer"),
			plain("MIDDLE_SECRET", "22-33-44-55-middle"),
			plain("INNER_SECRET", "33-44-55"),
		]);
		const text = "11-22-33-44-55-neither";
		const outbound = obfuscator.obfuscate(text);
		expect(outbound).toBe("11-22-#INNER_SECRET#-neither");
		expect(obfuscator.deobfuscate(outbound)).toBe(text);
	});
});

describe("a literal secret rejoined by another rule's replacement", () => {
	const joiningRules: SecretEntry[] = [
		plain("JOINED_SECRET", "abcd-joined-1234"),
		{ type: "regex", origin: "config", content: "<strip-me>", mode: "replace", replacement: "" },
	];

	/** An empty replacement deletes its match, so the literal's two halves become adjacent. */
	it("is masked after a replace rule deletes the text that split it", () => {
		const obfuscator = obfuscatorFor(joiningRules);
		expect(obfuscator.obfuscate("x abcd-joined<strip-me>-1234 y")).toBe("x #JOINED_SECRET# y");
	});

	it("is masked after a replace rule deletes several splits of it, beside an occurrence the first pass masked", () => {
		const obfuscator = obfuscatorFor(joiningRules);
		expect(obfuscator.obfuscate("abcd<strip-me>-joined<strip-me>-1234 and abcd-joined-1234")).toBe(
			"#JOINED_SECRET# and #JOINED_SECRET#",
		);
	});
});
