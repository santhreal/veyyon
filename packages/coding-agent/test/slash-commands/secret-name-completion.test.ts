import { describe, expect, it } from "bun:test";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { parseSecretCommand, SECRET_TUI_SUBCOMMANDS } from "@veyyon/coding-agent/secrets/secret-command";
import { buildTuiBuiltinSlashCommands } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

/**
 * What `/secret` may offer in its argument dropdown, and what it may never offer.
 *
 * TWO OPPOSITE DEFECTS HAVE SHIPPED HERE, and this suite has to hold both closed at once.
 *
 * The first was a dropdown that completed `rm` and `extend` and then the NAMES of stored
 * credentials, so `/secret rm git` offered `GITHUB_TOKEN`. Under the verbless grammar that arrived
 * later, accepting the suggestion no longer revoked anything: it stored the text `rm GITHUB_TOKEN`
 * as a credential and reported success.
 *
 * The fix for that was to offer one word, `manager`, and it outlived its reason. The verbs parse in
 * a terminal again, so a menu of one meant the other eight were typeable, documented in help, and
 * unmentioned at the one moment the operator is looking straight at the place they would be named.
 * `/secret ` showed a single word and no clue that anything else existed.
 *
 * So the menu is now every subcommand, DERIVED from the parser's own table of reserved words, and
 * the rows below pin the three things that are each easy to reintroduce and impossible to notice by
 * eye:
 *
 *  1. Every subcommand the parser reserves is offered, and nothing that is not one. Derived rather
 *     than listed, so a subcommand added to the union turns this red instead of shipping unoffered.
 *  2. No stored NAME and no stored VALUE reaches the dropdown. Values are what the whole subsystem
 *     exists to keep off screen; names belong to the manager, which picks from a list instead of
 *     rendering the vault on a keystroke.
 *  3. The prefix filter closes the dropdown on a real credential. An operator pasting a token must
 *     not have a suggestion list open over it.
 */

const KEY = new Uint8Array(32).fill(23);

/** Long enough to be obfuscatable. Asserted ABSENT from every completion, never present. */
const VALUES = {
	github: "github-secret-value-0000",
	stripe: "stripe-secret-value-0000",
	gitlab: "gitlab-secret-value-0000",
} as const;

function runtimeWith(obfuscator: SecretObfuscator | undefined): TuiSlashCommandRuntime {
	return { ctx: { session: { obfuscator } } } as unknown as TuiSlashCommandRuntime;
}

function threeStoredSecrets(): SecretObfuscator {
	return new SecretObfuscator(
		[
			{ type: "plain", origin: "config", content: VALUES.stripe, name: "STRIPE_KEY" },
			{ type: "plain", origin: "config", content: VALUES.github, name: "GITHUB_TOKEN" },
			{ type: "plain", origin: "config", content: VALUES.gitlab, name: "GITLAB_TOKEN" },
		],
		{ placeholderKey: KEY },
	);
}

/**
 * The declared return type allows a promise (other commands complete from disk), so this awaits
 * it. `/secret`'s own builder is synchronous, and that is the point: a dropdown on a line holding
 * a credential must not wait on I/O.
 */
async function completionsFor(argumentText: string, obfuscator: SecretObfuscator | undefined) {
	const secret = buildTuiBuiltinSlashCommands(runtimeWith(obfuscator)).find(c => c.name === "secret");
	expect(secret).toBeDefined();
	expect(secret?.getArgumentCompletions).toBeDefined();
	return await secret!.getArgumentCompletions!(argumentText);
}

/** The ghost text the composer draws, from the same materialized command the TUI runs. */
function hintFor(argumentText: string): string | null {
	const command = buildTuiBuiltinSlashCommands(runtimeWith(undefined)).find(c => c.name === "secret");
	expect(command?.getInlineHint).toBeDefined();
	return command!.getInlineHint!(argumentText);
}

/** Any command that declares both an inline hint and subcommands, to prove the fallback is shared. */
function hintForCommand(name: string, argumentText: string): string | null {
	const command = buildTuiBuiltinSlashCommands(runtimeWith(undefined)).find(c => c.name === name);
	expect(command?.getInlineHint).toBeDefined();
	return command!.getInlineHint!(argumentText);
}

describe("the ghost text after /secret", () => {
	/**
	 * THE BLANK-FIELD MOMENT, and the complaint that started this: `/secret` showed nothing and said
	 * nothing, so the only way to learn the grammar was to read the source. The declared hint is the
	 * one sentence that fits on that line, and it has to survive the subcommand hint being wired in
	 * beside it: the subcommand hint is null on an empty argument, so before the fallback existed
	 * adding one silently deleted the other.
	 */
	it("names the grammar before anything is typed", () => {
		const hint = hintFor("");

		expect(hint).toContain("<value>");
		expect(hint).toContain("list");
		expect(hint).toContain("--from-env");
		// A word the parser does not reserve would be typed as a command and stored as a credential.
		expect(hint).not.toContain("manager");
	});

	/**
	 * Mid-word it completes the verb and states what that verb wants, which is the half a static hint
	 * cannot do. `ex` is the interesting prefix: unambiguous, and its usage carries both a name and a
	 * lifetime, so a hint that stopped at the verb would leave the operator to guess the option.
	 */
	it("completes a partially typed verb and names its arguments", () => {
		expect(hintFor("ex")).toBe("tend <name> --ttl 7d");
		expect(hintFor("ren")).toBe("ame <name> <new-name>");
		expect(hintFor("cop")).toBe("y <name>");
		expect(hintFor("rm ")).toBe("<name> [--scope global]");
	});

	/**
	 * And it goes quiet once the operator is typing DATA. A hint that kept naming the usage over a
	 * half-typed secret name reads as if the line were incomplete, and over a pasted credential it is
	 * simply noise on the one line that should stay boring.
	 */
	it("goes quiet once an argument is being typed", () => {
		expect(hintFor("rm TOKEN")).toBeNull();
		expect(hintFor("ghp_liveCredential000")).toBeNull();
	});

	/**
	 * THE SHARED FALLBACK, on a command that is not `/secret`. `/collab` declares both an inline hint
	 * and subcommands, and the generic branch used to install the subcommand hint alone, so the
	 * declared string reached nothing: the empty-line case returned null and the operator who typed
	 * `/collab ` saw as little as the one who typed `/secret `. Pinned on a second command because a
	 * fallback that only worked for the command it was written for is not a fallback.
	 */
	it("falls back to a declared hint on any command that declares both", () => {
		expect(hintForCommand("collab", "")).toBe("[start|view|stop|status] [relayUrl]");
		// The subcommand hint still wins where it has something to say.
		expect(hintForCommand("collab", "sta")).toContain("rt");
	});
});

describe("what /secret offers in its argument dropdown", () => {
	/**
	 * THE DISCOVERY MOMENT. Typing nothing after `/secret ` is a blank field, and this menu is the
	 * only thing that says the feature has commands at all.
	 *
	 * Asserted against `SECRET_TUI_SUBCOMMANDS`, which the parser builds from the same table it
	 * routes with, so this cannot pass while a subcommand is missing from the menu. Storing comes
	 * first, then the edits a stored credential needs, then the answers about use.
	 */
	it("offers every subcommand the parser reserves, storing first", async () => {
		const items = await completionsFor("", threeStoredSecrets());

		expect(items?.map(item => item.label)).toEqual(SECRET_TUI_SUBCOMMANDS.map(sub => sub.name));
		expect(items?.[0]?.label).toBe("add");
		expect(items?.every(item => (item.description ?? "").length > 10)).toBe(true);
	});

	/**
	 * EVERY OFFERED WORD HAS TO RUN. A menu entry whose acceptance stores itself as a credential is
	 * the trap that shipped, so each entry is completed to its own declared shape and put back through
	 * the real parser on the surface the menu belongs to. None of them may come back as a value.
	 *
	 * The line is built from the entry's OWN `usage`, filled in from one table below, so an entry
	 * whose usage changes cannot quietly start being tested as something else. This is the row that
	 * fails if the menu is ever widened beyond the grammar, or the grammar narrowed beneath the menu.
	 */
	it("offers only words the terminal parser routes as commands", async () => {
		const arguments_: Record<string, string> = {
			add: "ghp_theCredentialItself",
			list: "",
			rm: "TOKEN_NAME",
			// A scope, because `clear` empties a whole vault and refuses to guess which one.
			clear: "--scope project",
			rename: "TOKEN_NAME OTHER_NAME",
			value: "TOKEN_NAME",
			scope: "TOKEN_NAME global",
			copy: "TOKEN_NAME",
			extend: "TOKEN_NAME --ttl 7d",
			log: "--limit 5",
			discard: "--scope project",
			help: "",
		};
		const items = (await completionsFor("", threeStoredSecrets())) ?? [];
		expect(items.length).toBeGreaterThan(1);

		for (const item of items) {
			const filled = arguments_[item.label];
			// A menu entry with no line here is an untested entry, which is how the last one shipped.
			expect(filled).toBeDefined();
			const request = parseSecretCommand([item.label, filled].join(" ").trim(), "tui");

			// The label is the subject: it is the string the menu offered, and the parse is what the
			// terminal does with it.
			expect(item.label).toBe(request.subcommand);
			if (item.label !== "add") expect(request.value).toBeUndefined();
		}
	});

	/**
	 * The old builder's exact input. `rm git` once returned `rm GITHUB_TOKEN` and `rm GITLAB_TOKEN`;
	 * accepting either now stores that text. Pinned as its own case because it is the literal
	 * keystroke sequence from the feature that was removed.
	 */
	it("offers nothing for a verb followed by a partial secret name", async () => {
		expect(await completionsFor("rm git", threeStoredSecrets())).toBeNull();
	});

	/**
	 * Neither a stored NAME nor a stored VALUE may appear in the dropdown. The value case is the
	 * one the whole subsystem exists for; the name case is what stops the dropdown from becoming a
	 * second `/secret list` that renders on every keystroke of a credential.
	 */
	it("never renders a stored name or value", async () => {
		for (const prefix of ["", "m", "man", "GITHUB", "git", "rm "]) {
			const rendered = JSON.stringify((await completionsFor(prefix, threeStoredSecrets())) ?? []);
			for (const value of Object.values(VALUES)) expect(rendered).not.toContain(value);
			for (const name of ["GITHUB_TOKEN", "GITLAB_TOKEN", "STRIPE_KEY"]) expect(rendered).not.toContain(name);
		}
	});

	/**
	 * A pasted credential closes the dropdown rather than hanging a suggestion over it. A paste
	 * arrives as one insert, so the prefix is the whole token and matches no subcommand; only a
	 * hand-typed word that is genuinely the start of one opens the menu.
	 */
	it("closes on text that is not a prefix of any subcommand", async () => {
		expect(await completionsFor("ghp_liveCredential000", threeStoredSecrets())).toBeNull();
		expect(await completionsFor("x", threeStoredSecrets())).toBeNull();
	});

	/**
	 * Partial and differently-cased spellings still reach their subcommand. The parser lowercases the
	 * reserved word, so a dropdown that matched case-sensitively would refuse to complete an input
	 * the command itself accepts.
	 */
	it("matches a partial or upper-case spelling", async () => {
		expect((await completionsFor("ren", undefined))?.map(item => item.label)).toEqual(["rename"]);
		expect((await completionsFor("REN", undefined))?.map(item => item.label)).toEqual(["rename"]);
		expect((await completionsFor("l", undefined))?.map(item => item.label)).toEqual(["list", "log"]);
	});

	/**
	 * Completion must not depend on the obfuscator, which is absent whenever secret protection is
	 * off. The old builder read stored names from it and went silent in that state, which is the
	 * state an operator most needs the menu in: nothing is stored yet, so nothing is protected yet.
	 */
	it("offers the whole menu when there is no obfuscator at all", async () => {
		expect((await completionsFor("", undefined))?.map(item => item.label)).toEqual(
			SECRET_TUI_SUBCOMMANDS.map(sub => sub.name),
		);
	});
});
