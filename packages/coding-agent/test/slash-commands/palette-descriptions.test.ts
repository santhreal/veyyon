/**
 * Palette rows are action-first: a command's live autocomplete description
 * must lead with what the command DOES ("Toggle plan mode · off"), never with
 * a bare state label ("Plan: off") that tells a new user nothing. This locks
 * the pattern at the source level so state-only descriptions can't creep back.
 */
import { describe, expect, it } from "bun:test";
import { BUILTIN_SLASH_COMMAND_DEFS } from "@veyyon/coding-agent/slash-commands/builtin-registry";

// A state-label return looks like `"Plan: off"` / `Loop: on (…)` — one or two
// capitalized words followed by ": " inside a string/template literal.
const STATE_LABEL = /["'`]\s*[A-Z][a-z]+(?: [a-z]+)?: /;

describe("builtin palette descriptions", () => {
	it("no getTuiAutocompleteDescription returns a bare state label", () => {
		for (const command of BUILTIN_SLASH_COMMAND_DEFS) {
			const hook = command.getTuiAutocompleteDescription;
			if (!hook) continue;
			expect(STATE_LABEL.test(hook.toString()), `/${command.name} palette description is state-only`).toBe(false);
		}
	});
});

/**
 * `/secret` answers "is this on, and what is in it" from the palette row itself.
 *
 * WHY THIS SUITE EXISTS. The row is the only place the operator sees the feature before committing
 * to a subcommand, and the state it reports is the difference between a credential that is being
 * substituted and one that is sitting inert. It is also the one palette description that must not
 * touch the disk: descriptions render on a keystroke, so the count comes from the in-memory
 * obfuscator and never from a vault read.
 *
 * The state is read from the LIVE runtime rather than the settings snapshot, because the runtime is
 * what decides whether a placeholder is actually being substituted right now. A session whose
 * setting says enabled but which has no obfuscator is protecting nothing, and the row must say so.
 */
describe("the /secret palette row", () => {
	const describeSecret = (session: unknown): string | undefined => {
		const command = BUILTIN_SLASH_COMMAND_DEFS.find(candidate => candidate.name === "secret");
		return command?.getTuiAutocompleteDescription?.({ ctx: { session } } as never);
	};

	/** Off is the shipped default, and the row says what fixes it rather than only naming the state. */
	it("says protection is off and how it turns on", () => {
		expect(describeSecret({ secretsEnabled: false, obfuscator: undefined })).toBe(
			"Store a credential the agent can use without ever seeing it · protection off, adding one turns it on",
		);
	});

	/** On with nothing stored is a real state: env-var and secrets.yml protection without a vault entry. */
	it("distinguishes protection on with nothing stored", () => {
		expect(describeSecret({ secretsEnabled: true, obfuscator: { namedSecretNames: () => [] } })).toBe(
			"Store a credential the agent can use without ever seeing it · protection on, none stored yet",
		);
	});

	/** Counted, never listed: the row is one terminal line and names belong in `/secret list`. */
	it("counts stored secrets without naming them", () => {
		const description = describeSecret({
			secretsEnabled: true,
			obfuscator: { namedSecretNames: () => ["GITHUB_TOKEN", "DEPLOY_KEY"] },
		});
		expect(description).toBe("Store a credential the agent can use without ever seeing it · protection on, 2 stored");
		expect(description).not.toContain("GITHUB_TOKEN");
		expect(description).not.toContain("DEPLOY_KEY");
	});

	/**
	 * The fail-closed reading. An enabled setting with no live obfuscator protects nothing, and a row
	 * that reported "protection on" there would tell the operator they were covered when they are not.
	 */
	it("reports off when the runtime has no obfuscator", () => {
		expect(describeSecret({ secretsEnabled: false, obfuscator: undefined })).toContain("protection off");
	});

	/** The palette renders before a session exists, so an absent session must not throw. */
	it("survives an absent session", () => {
		expect(describeSecret(undefined)).toContain("protection off");
	});
});
