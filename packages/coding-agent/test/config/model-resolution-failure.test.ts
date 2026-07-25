/**
 * A failed model resolution must name the RIGHT cause.
 *
 * WHY THIS SUITE EXISTS. Four unrelated failures used to collapse into one
 * sentence, `Model "<id>" not found`, plus advice to set an API key. That blames
 * the id the operator typed, which is precisely the thing that is correct when
 * the real cause is a credential that can no longer serve a token.
 *
 * The damage is on record. A 40-trial bench run hard-errored on a model id that
 * had passed 15/15 hours earlier on the same recipe and the same staged auth DB.
 * The message said the id was not found, so the id was blamed: a permanent code
 * comment was written asserting the model was "live-discovery-gated", arm
 * allowlists were edited to avoid it, and a whole sandbox model gate was built to
 * block a model that demonstrably worked. Every bit of that was reverted once the
 * credential turned out to be the cause.
 *
 * So these tests are not about wording preferences. They pin that an empty
 * registry and a credential-less registry are reported as availability failures,
 * that a correct id with an unauthenticated provider is not called unknown, and
 * that only a genuine mismatch says "not found" at all.
 */
import { describe, expect, it } from "bun:test";
import { describeModelResolutionFailure, findNearMatches } from "@veyyon/coding-agent/config/model-resolution-failure";

const CATALOG = [
	"google-antigravity/gemini-3.5-flash",
	"google-antigravity/gemini-3.6-flash",
	"anthropic/claude-opus-5",
	"openai/gpt-5",
];

describe("a credential failure is never reported as an unknown model id", () => {
	/**
	 * THE regression, stated exactly. The registry knows plenty of models and not
	 * one has a usable credential. The old path said `Model "..." not found`,
	 * which sent a real investigation into model allowlists for a day.
	 */
	it("calls a registry with no usable credentials an authentication failure", () => {
		const failure = describeModelResolutionFailure({
			requested: ["google-antigravity/gemini-3.6-flash"],
			allModelIds: CATALOG,
			availableModelIds: [],
		});
		expect(failure.kind).toBe("no-credentials");
		expect(failure.message).toContain("authentication failure");
		expect(failure.message).toContain("/login");
		// The exact wording that caused the misdiagnosis must not appear.
		expect(failure.message).not.toContain("not found");
	});

	/** It names providers to authenticate, so the message is actionable rather
	 * than merely accurate. */
	it("names providers the operator can sign in to", () => {
		const failure = describeModelResolutionFailure({
			requested: ["anthropic/claude-opus-5"],
			allModelIds: CATALOG,
			availableModelIds: [],
		});
		expect(failure.message).toContain("google-antigravity");
		expect(failure.message).toContain("anthropic");
	});

	/**
	 * An empty registry is its own cause. Nothing was searched, so "not found"
	 * asserts a search that never happened.
	 */
	it("distinguishes an empty registry from an unknown id", () => {
		const failure = describeModelResolutionFailure({
			requested: ["anything"],
			allModelIds: [],
			availableModelIds: [],
		});
		expect(failure.kind).toBe("empty-registry");
		expect(failure.message).toContain("registry is empty");
		expect(failure.message).not.toContain("not found");
	});

	/**
	 * A registry error outranks every other diagnosis: with a broken registry, no
	 * claim about the id is supportable. Swallowing it and guessing is what turns
	 * a config typo into a model hunt.
	 */
	it("surfaces a registry error instead of guessing about the id", () => {
		const failure = describeModelResolutionFailure({
			requested: ["anthropic/claude-opus-5"],
			allModelIds: [],
			availableModelIds: [],
			registryError: "models.json: unexpected token at line 3",
		});
		expect(failure.kind).toBe("registry-error");
		expect(failure.message).toContain("models.json: unexpected token at line 3");
		expect(failure.message).toContain("not the problem");
	});

	/**
	 * A registry error is reported even when models did load, because a partially
	 * loaded registry can be missing exactly the model that was requested.
	 */
	it("reports a registry error even when some models loaded", () => {
		const failure = describeModelResolutionFailure({
			requested: ["custom/my-model"],
			allModelIds: CATALOG,
			availableModelIds: CATALOG,
			registryError: "custom models config failed to parse",
		});
		expect(failure.kind).toBe("registry-error");
	});
});

describe("a correct id with an unauthenticated provider is not called unknown", () => {
	/**
	 * The id names a real model and the operator simply has no credential for that
	 * provider. Saying the model does not exist is plainly false, and it sends
	 * them to fix a spelling that was already right.
	 */
	it("says the credential is missing, not the model", () => {
		const failure = describeModelResolutionFailure({
			requested: ["anthropic/claude-opus-5"],
			allModelIds: CATALOG,
			availableModelIds: ["openai/gpt-5"],
		});
		expect(failure.kind).toBe("provider-unauthenticated");
		expect(failure.message).toContain("anthropic");
		expect(failure.message).toContain("The model id is correct");
		expect(failure.message).not.toContain("not found");
	});

	/** The bare id (no provider prefix) is how people usually type it, and it must
	 * reach the same conclusion. */
	it("recognises a bare model id without its provider prefix", () => {
		const failure = describeModelResolutionFailure({
			requested: ["claude-opus-5"],
			allModelIds: CATALOG,
			availableModelIds: ["openai/gpt-5"],
		});
		expect(failure.kind).toBe("provider-unauthenticated");
	});
});

describe("a genuine mismatch is reported as one, with near-matches", () => {
	/** Credentials exist and the id really is not among them. This is the only
	 * case where "not found" is a true statement. */
	it("says not found only when authenticated models exist and none match", () => {
		const failure = describeModelResolutionFailure({
			requested: ["gemini-9.9-ultra"],
			allModelIds: CATALOG,
			availableModelIds: CATALOG,
		});
		expect(failure.kind).toBe("unknown-model");
		expect(failure.message).toContain("not found");
	});

	/** A denial with no alternative makes the operator guess. A near-match turns
	 * a typo into a one-line fix. */
	it("suggests the real spelling for a mistyped version", () => {
		const failure = describeModelResolutionFailure({
			requested: ["google-antigravity/gemini-3.7-flash"],
			allModelIds: CATALOG,
			availableModelIds: CATALOG,
		});
		expect(failure.kind).toBe("unknown-model");
		expect(failure.nearMatches.length).toBeGreaterThan(0);
		expect(failure.message).toContain("Did you mean");
		expect(failure.nearMatches).toContain("google-antigravity/gemini-3.5-flash");
	});

	/** Near-matches must come from the AUTHENTICATED set. Suggesting a model the
	 * operator cannot use trades one dead end for another. */
	it("suggests only models that have usable credentials", () => {
		const failure = describeModelResolutionFailure({
			requested: ["claude-opus-9"],
			allModelIds: CATALOG,
			availableModelIds: ["openai/gpt-5"],
		});
		expect(failure.nearMatches).not.toContain("anthropic/claude-opus-5");
	});

	/** With nothing similar to suggest, it points at the command that lists the
	 * real options rather than trailing off. */
	it("points at /model when nothing resembles the request", () => {
		const failure = describeModelResolutionFailure({
			requested: ["zzzzzzzz"],
			allModelIds: CATALOG,
			availableModelIds: CATALOG,
		});
		expect(failure.nearMatches).toEqual([]);
		expect(failure.message).toContain("/model");
	});

	/** Several `--model` patterns read back as a list, so the operator can see
	 * which of their alternatives were tried. */
	it("reads back every requested pattern", () => {
		const failure = describeModelResolutionFailure({
			requested: ["aaa", "bbb"],
			allModelIds: CATALOG,
			availableModelIds: CATALOG,
		});
		expect(failure.message).toContain('"aaa"');
		expect(failure.message).toContain('"bbb"');
	});
});

describe("findNearMatches", () => {
	/** An exact hit outranks everything, so a suggestion list never buries the
	 * thing the operator actually asked for. */
	it("ranks an exact id first", () => {
		expect(findNearMatches("openai/gpt-5", CATALOG)[0]).toBe("openai/gpt-5");
	});

	/** Dropping the provider prefix is the most common way to type a model. */
	it("matches a bare id against its qualified form", () => {
		expect(findNearMatches("gpt-5", CATALOG)).toContain("openai/gpt-5");
	});

	/** An invented suffix still resolves to the real model. */
	it("matches an id carrying an invented suffix", () => {
		expect(findNearMatches("gpt-5-latest", CATALOG)).toContain("openai/gpt-5");
	});

	/** A short fragment must not drag in the whole catalog; suggestions that match
	 * everything are the same as no suggestions. */
	it("does not match on a one or two character fragment", () => {
		expect(findNearMatches("g", CATALOG)).toEqual([]);
	});

	/** The list is bounded, so a large catalog cannot bury the message. */
	it("caps the number of suggestions", () => {
		const many = Array.from({ length: 40 }, (_, index) => `openai/gpt-5-variant-${index}`);
		expect(findNearMatches("gpt-5", many).length).toBeLessThanOrEqual(5);
	});

	/** Case is not a real mismatch, and treating it as one produces a denial for
	 * an id that is otherwise exactly right. */
	it("ignores case", () => {
		expect(findNearMatches("OpenAI/GPT-5", CATALOG)).toContain("openai/gpt-5");
	});
});
