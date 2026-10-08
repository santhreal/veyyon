/**
 * The words `/secret` reserves and the subcommand each one names, apart from the command's logic so
 * the composer's completion menu reads them without loading the parser and the vault operations.
 */

/**
 * Every subcommand `/secret` understands.
 *
 * There is no verb that opens a screen. Every capability is a word here, so a client with a
 * terminal and a client with none reach the same feature through the same grammar, and a rule
 * proved over this union is proved for both.
 */
export type SecretSubcommand =
	| "add"
	// READING A VALUE OUT OF THE ENVIRONMENT IS ITS OWN COMMAND, not a modifier on `add`. As
	// `--from-env` it was a flag, and as a plain word after `add` it would have been unreadable: the
	// line after `add` is the credential, so a leading `from-env` there is either syntax or the first
	// word of somebody's passphrase and nothing can tell which. A command word is decided before any
	// value is read, so the collision cannot exist.
	| "from-env"
	| "list"
	| "rm"
	| "clear"
	| "rename"
	| "value"
	| "scope"
	| "copy"
	| "extend"
	| "log"
	| "discard"
	| "help";

/**
 * The words `/secret` reserves, and which subcommand each one names.
 *
 * ONE OWNER for every spelling, so the parser, the help text and the completion menu cannot
 * disagree about what is a command and what is a credential. The menu derives its entries from
 * this map rather than listing them again, which is what makes a new subcommand offerable the
 * moment it is parseable.
 *
 * WHY RESERVING WORDS IS SAFE. A stored value is arbitrary bytes chosen by an issuer, so nobody's
 * API token is the literal word `list`, and `add` is what resolves the collision: the masked field
 * reached by `/secret add` accepts any text at all, and `/secret add list` stores the rest of the
 * line verbatim. Reserving EVERY verb is what makes that trade safe: a grammar that reserved only some
 * of them would store the string `list` as a credential and switch protection on, and store
 * `rm TOKEN` for `/secret rm TOKEN`, so the two commands an operator reaches for right after
 * storing something would fill the vault with garbage while the help text advertised them.
 *
 * THE FIRST WORD DECIDES, not the shape of the rest. `/secret log 50` is a malformed `log` and is
 * refused; it is never re-read as a credential that happens to begin with `log`. A grammar that
 * fell back to storing on a shape mismatch would put the silent-storage bug back for exactly the
 * lines an operator gets slightly wrong, which are the ones that need the explanation.
 */
export const SECRET_VERB_SPELLINGS: Record<string, SecretSubcommand> = {
	// Ordered as the completion menu is read: storing first, then the edits a stored credential
	// needs, then the two answers about use, and the repair last.
	add: "add",
	// TWO SPELLINGS, like every command below that has a natural twin. `env` is what fingers reach
	// for; `from-env` is what the old flag was called, so the operator who knew it lands on the
	// command that replaced it rather than on a refusal.
	"from-env": "from-env",
	env: "from-env",
	list: "list",
	rm: "rm",
	remove: "rm",
	delete: "rm",
	// EVERY WORD AN OPERATOR REACHES FOR TO EMPTY THE VAULT, reserved together. Before `clear`
	// existed, none of these was a verb, so the grammar's fallback stored each one AS A CREDENTIAL:
	// `/secret clear` filed the six-character string "clear" under a generated name, `/secret clear
	// everything` filed the literal "clear everything", and because the first successful `add` also turns
	// `secrets.enabled` on, the command an operator typed to empty the vault filled it and switched
	// the subsystem on. That is the exact failure the note above predicted for a partially reserved
	// grammar, arriving through the one verb nobody had written yet.
	clear: "clear",
	wipe: "clear",
	purge: "clear",
	empty: "clear",
	reset: "clear",
	rename: "rename",
	name: "rename",
	value: "value",
	replace: "value",
	scope: "scope",
	move: "scope",
	copy: "copy",
	extend: "extend",
	renew: "extend",
	log: "log",
	audit: "log",
	// No alias. The verbs above have two natural spellings each; `discard` has no twin, and
	// inventing one for a destructive-looking repair only widens what a typo can reach.
	discard: "discard",
	help: "help",
};

/**
 * What the terminal says each subcommand is for, and what it takes after the verb.
 *
 * A Record over the union rather than a list, so a subcommand cannot be parseable and unoffered:
 * adding a member to {@link SecretSubcommand} fails to compile until it has a line here. That is
 * the completion menu's completeness expressed as a type instead of as a test nobody updates.
 *
 * THE TERMINAL'S TRUTH, WHICH IS NOT THE DECLARATION'S. `/secret add` takes no name here, because
 * a name parsed off this line would be a credential in plaintext metadata. The declaration in
 * `builtin-declarations.ts` keeps the noninteractive spellings, which is what an ACP client is
 * told it may run.
 */
const SECRET_TUI_SUBCOMMAND_HELP: Record<SecretSubcommand, { usage: string; description: string }> = {
	add: { usage: "<value>", description: "Store a credential; the rest of the line is the value" },
	"from-env": {
		usage: "<VAR> [<name>]",
		description: "Store the value of an environment variable, typing nothing",
	},
	list: { usage: "", description: "Show active secrets, never their values" },
	rm: { usage: "<name> [global]", description: "Remove a stored secret" },
	clear: { usage: "profile", description: "Remove every secret in one vault, naming what it removed" },
	rename: { usage: "<name> <new-name>", description: "Give a stored secret a different name" },
	value: { usage: "<name>", description: "Replace a secret's value, keeping its name and lifetime" },
	scope: { usage: "<name> global", description: "Move a secret to the profile, project or global vault" },
	copy: { usage: "<name>", description: "Copy #NAME#, the placeholder, never the value" },
	extend: { usage: "<name> 7d", description: "Give a stored secret a fresh lifetime" },
	log: { usage: "[<name>] [50]", description: "Show which secrets were used, and where" },
	discard: { usage: "project", description: "Move a broken vault file aside" },
	help: { usage: "", description: "Show every form /secret understands" },
};

/**
 * The terminal completion menu: canonical spellings only, in the order above.
 *
 * Aliases are parsed and not offered. `remove`, `delete`, `renew`, `name`, `replace`, `move` and
 * `audit` and `env` exist so muscle memory lands somewhere, and listing them beside their canonical
 * twins would double a menu whose whole job is to say what the commands are.
 */
export const SECRET_TUI_SUBCOMMANDS: readonly { name: SecretSubcommand; usage: string; description: string }[] =
	Object.entries(SECRET_VERB_SPELLINGS)
		.filter(([word, subcommand]) => word === subcommand)
		// The VALUE is used as the name, not the key: the filter above has just established they are
		// the same string, and the value carries the `SecretSubcommand` type a caller needs in order to
		// push a menu entry back through the parser without a cast.
		.map(([, subcommand]) => ({ name: subcommand, ...SECRET_TUI_SUBCOMMAND_HELP[subcommand] }));
