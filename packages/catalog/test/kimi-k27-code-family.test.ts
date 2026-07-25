/**
 * `matchesKimiK27CodeFamily`: which models are Moonshot's Kimi K2.7 Code family.
 *
 * WHY THIS SUITE EXISTS. The family needs thinking forced on, and BOTH compat layers have to
 * recognise it: a request can reach Moonshot through the OpenAI-compatible path or the
 * Anthropic-compatible one, and each layer applied its own private copy of the id pattern and of
 * the match. Four statements of one model-identity rule. Drift there fails in the worst available
 * way, silently and asymmetrically: the same account gets thinking on requests that happen to go
 * through one transport and not on requests that go through the other, and the symptom looks like
 * the model being inconsistent rather than like a catalog bug.
 *
 * The spellings below are not hypothetical variations. The upstream has published `kimi-k2.7-code`,
 * `kimi-k2p7-code` and the `-highspeed` variant, and aggregators prefix a vendor segment, so each
 * is pinned rather than left to the reader to trust from the regular expression.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { matchesKimiK27CodeFamily } from "../src/compat/kimi";

describe("ids the family publishes", () => {
	/** The dotted spelling, which is what the model card uses. */
	it("matches kimi-k2.7-code", () => {
		expect(matchesKimiK27CodeFamily({ id: "kimi-k2.7-code" })).toBe(true);
	});

	/** `p` stands in for the decimal point wherever a dot is awkward in an id. */
	it("matches the kimi-k2p7-code spelling", () => {
		expect(matchesKimiK27CodeFamily({ id: "kimi-k2p7-code" })).toBe(true);
	});

	it("matches the underscore and hyphen separators", () => {
		expect(matchesKimiK27CodeFamily({ id: "kimi_k2_7_code" })).toBe(true);
		expect(matchesKimiK27CodeFamily({ id: "kimi-k2-7-code" })).toBe(true);
	});

	/** Same model, faster serving tier: still the family, still needs thinking on. */
	it("matches the highspeed variant", () => {
		expect(matchesKimiK27CodeFamily({ id: "kimi-k2.7-code-highspeed" })).toBe(true);
		expect(matchesKimiK27CodeFamily({ id: "kimi-k2p7-code-highspeed" })).toBe(true);
	});

	/** Aggregators prefix a vendor segment; the segment boundary is what the leading `/` allows. */
	it("matches a vendor-prefixed id", () => {
		expect(matchesKimiK27CodeFamily({ id: "moonshotai/kimi-k2.7-code" })).toBe(true);
	});

	/** Ids arrive in whatever case the upstream chose. */
	it("is case-insensitive", () => {
		expect(matchesKimiK27CodeFamily({ id: "Kimi-K2.7-Code" })).toBe(true);
	});
});

describe("the kimi-for-coding alias", () => {
	/**
	 * That id does not name a model. It names whichever coding model the account is currently
	 * entitled to, so only the display name says which one it resolved to today, and reading the
	 * name is the only way to tell the family apart from its successor.
	 */
	it("is the family when its display name says K2.7 Code", () => {
		expect(matchesKimiK27CodeFamily({ id: "kimi-for-coding", name: "Kimi K2.7 Code" })).toBe(true);
		expect(matchesKimiK27CodeFamily({ id: "kimi-for-coding", name: "kimi k27 code" })).toBe(true);
	});

	/** No name means no evidence, and the alias alone is not evidence. */
	it("is not the family when the name is absent", () => {
		expect(matchesKimiK27CodeFamily({ id: "kimi-for-coding" })).toBe(false);
	});

	/** The whole point of reading the name: the alias pointing at a different model. */
	it("is not the family when the name names another model", () => {
		expect(matchesKimiK27CodeFamily({ id: "kimi-for-coding", name: "Kimi K2 Instruct" })).toBe(false);
		expect(matchesKimiK27CodeFamily({ id: "kimi-for-coding", name: "Kimi K3 Code" })).toBe(false);
	});

	/** The name is only consulted for that one id: another model's name cannot opt it in. */
	it("does not let a display name opt in any other id", () => {
		expect(matchesKimiK27CodeFamily({ id: "some-proxy-model", name: "Kimi K2.7 Code" })).toBe(false);
	});
});

describe("models that are not the family", () => {
	/** The nearest neighbours, which must not have thinking forced on. */
	it("rejects other Kimi models", () => {
		expect(matchesKimiK27CodeFamily({ id: "kimi-k2-instruct" })).toBe(false);
		expect(matchesKimiK27CodeFamily({ id: "kimi-k2.7-instruct" })).toBe(false);
		expect(matchesKimiK27CodeFamily({ id: "kimi-k2.5-code" })).toBe(false);
		expect(matchesKimiK27CodeFamily({ id: "kimi-k3-code" })).toBe(false);
	});

	/** The id has to END at the family, so a longer successor id is not swept in. */
	it("rejects an id that only starts with a family id", () => {
		expect(matchesKimiK27CodeFamily({ id: "kimi-k2.7-code-preview" })).toBe(false);
		expect(matchesKimiK27CodeFamily({ id: "kimi-k2.7-code-highspeed-v2" })).toBe(false);
	});

	/**
	 * The segment boundary is a real boundary, not a substring search: another vendor's model whose
	 * id merely ends in those characters is a different model.
	 */
	it("rejects a family id embedded without a segment boundary", () => {
		expect(matchesKimiK27CodeFamily({ id: "notkimi-k2.7-code" })).toBe(false);
	});

	it("rejects unrelated models and an empty id", () => {
		expect(matchesKimiK27CodeFamily({ id: "gpt-5" })).toBe(false);
		expect(matchesKimiK27CodeFamily({ id: "" })).toBe(false);
	});
});

describe("one owner", () => {
	/**
	 * The lock. Both compat layers carried the pattern AND the match, one of them documenting
	 * itself as a mirror of the other, which is what let a rule about one model live in four
	 * places. A copy reappearing here is the drift this suite exists to prevent, so it fails the
	 * build rather than waiting to be noticed as inconsistent thinking behaviour in production.
	 */
	it("is defined once, and both compat layers import it", async () => {
		for (const name of ["openai.ts", "anthropic.ts"]) {
			const source = await Bun.file(path.join(import.meta.dir, "../src/compat", name)).text();

			expect(source).not.toContain("function matchesKimiK27CodeFamily");
			expect(source).not.toContain("KIMI_K27_CODE_MODEL_PATTERN");
			expect(source).toContain('from "./kimi"');
		}
	});
});
