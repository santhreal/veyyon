/**
 * The one lookup every prompt registry uses, and the reason it throws.
 *
 * WHY THIS SUITE EXISTS. Four packages ship prompt registries, and each needs the
 * same answer to "what happens when an id is not there". Two of them had no answer at
 * all: a caller holding an id in a variable indexed the table directly, so a drifted
 * id yielded `undefined` and `.text` on it reached the model as no instructions.
 * Nothing throws in that path. The model still replies, the run still completes, and
 * the missing brief surfaces as the model ignoring one.
 *
 * That is what makes the throw the feature rather than an inconvenience, and why it is
 * tested here rather than four times over: the failure this prevents is invisible
 * downstream, so a registry that quietly re-derived the lookup with `?? ""` would look
 * correct forever.
 *
 * The suggestion is tested with the same seriousness. In a table of 160 ids a bare
 * refusal sends the reader to grep for a name they nearly typed, so the near miss is
 * part of the contract, not a nicety.
 */
import { describe, expect, it } from "bun:test";
import { type PromptEntry, requirePromptFrom } from "../src/prompt-registry";

const REGISTRY = {
	"dialect/anthropic": { text: "anthropic guide", purpose: "teaches the anthropic call syntax" },
	"dialect/gemma": { text: "gemma guide", purpose: "teaches the gemma call syntax" },
	"session/system-prompt": {
		text: "the system prompt",
		purpose: "what defines a session",
		sections: [{ id: "role", name: "ROLE", purpose: "who the agent is", optional: false }],
	},
} as const satisfies Record<string, PromptEntry>;

const registry = REGISTRY as Record<string, PromptEntry>;

describe("requirePromptFrom", () => {
	/** The ordinary case returns the ROW, not a copy, so `sections` and `purpose` survive. */
	it("returns the registered row itself", () => {
		expect(requirePromptFrom(registry, "session/system-prompt", "pkg/src/prompts")).toBe(
			REGISTRY["session/system-prompt"],
		);
	});

	/**
	 * THE POINT OF THE FUNCTION. An unknown id must not resolve to an empty prompt: a
	 * model handed no instructions still answers, so the bug arrives as bad output
	 * rather than as a failure anyone can trace back to a missing row.
	 */
	it("throws on an unknown id rather than returning undefined", () => {
		expect(() => requirePromptFrom(registry, "session/nope", "pkg/src/prompts")).toThrow(
			/unknown prompt "session\/nope"/,
		);
	});

	/**
	 * The error names the directory, because "an id is a path under src/prompts" is
	 * ambiguous once four packages have one. A reader who does not know WHICH tree to
	 * open has been told nothing actionable.
	 */
	it("names the directory the ids come from", () => {
		expect(() => requirePromptFrom(registry, "session/nope", "packages/ai/src/prompts")).toThrow(
			/in packages\/ai\/src\/prompts; an id is the path under that directory without \.md/,
		);
	});

	/** A typo gets its near miss, quoted, so the fix is readable in the message. */
	it("suggests the nearest registered id for a typo", () => {
		expect(() => requirePromptFrom(registry, "dialect/anthropik", "pkg/src/prompts")).toThrow(
			/Did you mean "dialect\/anthropic"/,
		);
	});

	/**
	 * A wholly unrelated id gets no suggestion rather than a bad one. A "did you mean"
	 * pointing at something unrelated is worse than silence: it reads as confirmation
	 * that the registry holds a near-match, and sends the reader to check the wrong row.
	 */
	it("offers no suggestion when nothing is close", () => {
		let message = "";
		try {
			requirePromptFrom(registry, "zzzzzzzzzzzzzzzzzzzz", "pkg/src/prompts");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain('unknown prompt "zzzzzzzzzzzzzzzzzzzz"');
		expect(message).not.toContain("Did you mean");
	});

	/**
	 * An empty id is refused like any other miss. It is the value a caller gets from an
	 * unset config field or a bad parse, so it is the id most likely to actually arrive,
	 * and `registry[""]` is `undefined` rather than an error.
	 */
	it("refuses an empty id", () => {
		expect(() => requirePromptFrom(registry, "", "pkg/src/prompts")).toThrow(/unknown prompt ""/);
	});

	/**
	 * An inherited property name is not a registration. `registry["toString"]` finds
	 * `Object.prototype.toString` and returns a function, so a lookup written as a plain
	 * index would hand a caller a function where a prompt row belonged, and `.text` on it
	 * is `undefined` — the empty-prompt bug again, arriving through the prototype.
	 */
	it("refuses an inherited property name", () => {
		for (const inherited of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
			expect(() => requirePromptFrom(registry, inherited, "pkg/src/prompts"), inherited).toThrow(/unknown prompt/);
		}
	});

	/**
	 * It works on an empty registry, where there is nothing to suggest and nothing to
	 * find. A registry mid-construction is exactly when the message has to stay readable.
	 */
	it("refuses every id when the registry is empty", () => {
		expect(() => requirePromptFrom({}, "anything", "pkg/src/prompts")).toThrow(/unknown prompt "anything"/);
	});
});
