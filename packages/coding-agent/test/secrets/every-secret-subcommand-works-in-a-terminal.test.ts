import { describe, expect, it } from "bun:test";
import {
	parseSecretCommand,
	SECRET_TUI_SUBCOMMANDS,
	SECRET_VERB_SPELLINGS,
	secretCommandUsage,
} from "@veyyon/coding-agent/secrets/secret-command";

/**
 * WHY THIS SUITE EXISTS.
 *
 * `/secret`'s help advertised `add`, `list`, `rm`, `extend` and `log`, and in a terminal none of
 * them parsed. The argument line was the credential, full stop, so every one of those words was
 * STORED: `/secret list` put the string `list` in the vault under a generated name, switched secret
 * protection on because storing a credential is the opt-in, and reported success. An operator
 * following the product's own help filled the vault with the names of the commands they were trying
 * to run, and the only way to find out was to open the manager and read the rows.
 *
 * The other half of the same defect was the argument dropdown, which offered one word out of nine.
 *
 * THE CLASS, not the incident: every reserved word must route as a command on both surfaces, every
 * alias must reach its canonical subcommand, and no reserved word may ever come back as a stored
 * value. The variant space is DERIVED from `SECRET_VERB_SPELLINGS` at run time, so a subcommand or
 * an alias added later is covered without anybody remembering this file, and a member added to the
 * union with no menu entry fails to compile before it gets here.
 *
 * WHAT THIS DOES NOT CATCH: what each subcommand then DOES to the vault. Those live per verb
 * (`the-secret-list-is-a-readable-table`, `a-discarded-vault-is-moved-not-destroyed`, and the audit
 * suites). This file is only about which reading a line gets.
 */

/** A line that satisfies each subcommand's shape, so a refusal here is a routing failure. */
const WELL_FORMED: Record<string, string> = {
	add: "ghp_theCredentialItself",
	list: "",
	rm: "TOKEN_NAME",
	rename: "TOKEN_NAME OTHER_NAME",
	value: "TOKEN_NAME",
	scope: "TOKEN_NAME global",
	copy: "TOKEN_NAME",
	extend: "TOKEN_NAME --ttl 7d",
	log: "--limit 5",
	discard: "--scope project",
	help: "",
};

describe("every reserved word is a command in a terminal, not a credential", () => {
	for (const [word, subcommand] of Object.entries(SECRET_VERB_SPELLINGS)) {
		/**
		 * The whole point, one row per spelling including the four aliases. `value` absent is the
		 * assertion that matters: it is set only when a line was read as a credential, which is what
		 * every one of these lines used to come back as.
		 */
		it(`routes ${word} to ${subcommand}`, () => {
			const line = [word, WELL_FORMED[subcommand] ?? ""].join(" ").trim();
			const request = parseSecretCommand(line, "tui");

			expect(request.subcommand).toBe(subcommand);
			// `add` is the one word whose well-formed line carries a value, because there `add` is a
			// synonym for the bare form and the rest of the line IS the credential.
			if (subcommand !== "add") expect(request.value).toBeUndefined();
		});
	}

	/**
	 * Case, because an operator types what the help shows and the help is lower case while a habit of
	 * typing commands in caps is not rare. The parser lowercases the first word; a regression that
	 * stopped would store `LIST` as a credential, silently, which is the original defect wearing a
	 * different case.
	 */
	it("routes a reserved word whatever its case", () => {
		for (const spelling of ["LIST", "List", "lIsT"]) {
			expect(parseSecretCommand(spelling, "tui").subcommand).toBe("list");
		}
	});

	/**
	 * A malformed reserved line REFUSES. This is the row that separates the new grammar from a
	 * cosmetic change: a shape mismatch could plausibly have fallen back to "then it must be a
	 * credential", and that fallback is precisely what made `/secret log 50` and `/secret rm` store
	 * garbage. Every refusal also has to name the escape, or the operator whose credential really
	 * does start with a reserved word is stuck.
	 */
	it("refuses a malformed reserved line instead of storing it, and names the escape", () => {
		for (const line of [
			"log 50",
			"list something",
			"rm A B",
			"extend TOK 7d",
			"copy A B",
			"value A B",
			"scope TOK",
		]) {
			expect(() => parseSecretCommand(line, "tui")).toThrow(/\/secret -- <value>/u);
		}
	});

	/**
	 * `discard` refuses for its own reason, which must survive the routing change: the scope names a
	 * FILE to move aside, so there is no default and a bare word there would read as a secret name.
	 */
	it("still refuses a bare discard, on its own grounds", () => {
		expect(() => parseSecretCommand("discard", "tui")).toThrow(/no default/u);
	});
});

describe("the escape is the one way a credential wears a reserved word", () => {
	/**
	 * Derived over the same table, because the escape has to work for EVERY reserved word or the
	 * grammar has locked somebody out. The stored value keeps the reserved word: `-- list` is the
	 * credential `list`, not an empty one.
	 */
	for (const word of Object.keys(SECRET_VERB_SPELLINGS)) {
		it(`stores a credential beginning with ${word}`, () => {
			expect(parseSecretCommand(`-- ${word} and the rest`, "tui")).toEqual({
				subcommand: "add",
				value: `${word} and the rest`,
			});
		});
	}

	/** Whitespace inside an escaped credential survives, exactly as it does in the bare form. */
	it("keeps whitespace inside an escaped credential", () => {
		expect(parseSecretCommand("--   list  two\tthree ", "tui")).toEqual({
			subcommand: "add",
			value: "list  two\tthree",
		});
	});

	/**
	 * `--` with nothing after it is a mistake, not an empty credential: storing an empty value would
	 * create an entry that expands to nothing and protects nothing. The refusal points at the masked
	 * field, which is where somebody who typed `--` and hesitated actually wanted to be.
	 */
	it("refuses an escape with nothing after it", () => {
		expect(() => parseSecretCommand("--", "tui")).toThrow(/hidden field/u);
	});
});

describe("the terminal help and the terminal menu describe the same grammar", () => {
	/**
	 * THE THREE PLACES A SUBCOMMAND HAS TO EXIST AT ONCE: the parser, the help text and the dropdown.
	 * The defect was one of them disagreeing with the other two, twice over, so the agreement is
	 * asserted as a set rather than per member.
	 *
	 * `add` is exempt from the help half only: the terminal spells it `/secret <value>`, because the
	 * verb is a synonym there and leading with it would put a word in front of the one action that
	 * needs none.
	 */
	it("names every menu entry in the help, and parses every one", () => {
		const usage = secretCommandUsage("tui");

		for (const sub of SECRET_TUI_SUBCOMMANDS) {
			expect(parseSecretCommand([sub.name, WELL_FORMED[sub.name] ?? ""].join(" ").trim(), "tui").subcommand).toBe(
				sub.name,
			);
			if (sub.name !== "add" && sub.name !== "help") expect(usage).toContain(`/secret ${sub.name}`);
		}
	});

	/**
	 * The menu is the canonical spellings and only those. Offering `remove` beside `rm` would double
	 * a list whose whole job is to say what the small set of things is, and the aliases exist for
	 * muscle memory rather than for discovery.
	 */
	it("offers canonical spellings only, aliases parsed but unlisted", () => {
		expect(SECRET_TUI_SUBCOMMANDS.map(sub => sub.name)).toEqual(
			Object.entries(SECRET_VERB_SPELLINGS)
				.filter(([word, subcommand]) => word === subcommand)
				.map(([, subcommand]) => subcommand),
		);
		// Each alias completed to the shape of the subcommand it reaches, not to `rm`'s: `audit` is
		// `log`, which takes no bare word, and a shared line would refuse for the wrong reason.
		for (const alias of ["remove", "delete", "renew", "audit"]) {
			expect(SECRET_TUI_SUBCOMMANDS.some(sub => sub.name === alias)).toBe(false);
			const canonical = SECRET_VERB_SPELLINGS[alias];
			expect(canonical).toBeDefined();
			const request = parseSecretCommand([alias, WELL_FORMED[canonical ?? ""] ?? ""].join(" ").trim(), "tui");
			expect(request.subcommand).toBe(canonical);
			expect(request.value).toBeUndefined();
		}
	});
});
