/**
 * What `/secret` does, as pure logic over a vault.
 *
 * SEPARATE FROM THE REGISTRY ON PURPOSE. Domain logic does not import the CLI or the TUI, so
 * every rule below is testable without constructing a session, and the registry handler is a
 * thin adapter that parses a line and prints a string. The alternative, putting this inside
 * the 2000-line builtin registry, would make the security-relevant behaviour reachable only
 * through a live TUI.
 *
 * ONE GRAMMAR: A VERB, THEN WHAT THE VERB TAKES. `/secret <command> [value]`, on every surface.
 * Every subcommand parses on both: `add`, `list`, `rm`, `clear`, `rename`, `value`, `scope`, `copy`,
 * `extend`, `log`, `discard` and `help`. What the surfaces disagree about is where a credential may
 * come from, because that is a security property and not a matter of taste: a client with no way to
 * hide what is typed reaches a value only through the `from-env` command.
 *
 * A FIRST WORD THAT IS NOT A COMMAND IS NOTHING, and is refused. The terminal used to read any
 * unreserved line as the credential itself, so `/secret ghp_x` stored a token with no verb. It cost
 * one paste, and it cost the grammar three mechanisms to hold itself together: every word the
 * command might ever need had to be reserved up front, or a mistyped verb became an entry
 * (`/secret lst` stored the string `lst` and switched protection on); reserving them created a
 * collision with credentials that begin with such a word; and that collision needed an escape of its
 * own. Requiring the verb removes all three at once, since a value is only ever read after `add`.
 *
 * WHY THE TERMINAL FORM DROPPED THE NAME. `/secret add <name> <value>` demanded a label before it
 * would accept the thing being labelled, and the two positionals had no unique reading once the
 * value was arbitrary text. Worse, the name came FIRST, so `/secret add ghp_realToken` stored a
 * live credential as a NAME with no value attached. In a terminal `add` takes no name: the value is
 * the rest of the line, and the name is asked afterwards, optional, with a generated one waiting if
 * the operator declines.
 *
 * WHERE THE VALUE COMES FROM, in order of how much it leaks:
 *   - `from-env VAR`, its own command, reads it out of the environment. The credential is never typed, so it
 *     never enters the input buffer or the scrollback. This is the recommended form and the
 *     only one that works in a non-interactive client.
 *   - a masked field, reached by `/secret add` with nothing after it, keeps it out of the
 *     scrollback but not out of the input buffer.
 *   - an inline value is accepted, because stashing a token should cost one paste and one word.
 *     It is visible on screen until the editor is cleared, so {@link addSecret} says so in its
 *     confirmation rather than leaving the user to assume otherwise.
 */
import { Ellipsis, padding, sanitizeSingleLine, truncateToWidth, visibleWidth } from "@veyyon/tui/utils";
import { errorMessage, formatCount } from "@veyyon/utils";
import type { SecretAuditLog, SecretExpansionRecord } from "./audit";
import { MAX_SECRET_NAME_LENGTH } from "./placeholder";
import { planScopeMove } from "./scope-move";
import {
	DEFAULT_TTL_MS,
	describeTimeLeft,
	formatTtl,
	isTtlWord,
	normaliseSecretName,
	parseTtl,
	type ScopedVaultEntry,
	type SecretVault,
	type VaultScope,
	WARN_AT_FRACTIONS,
	warningThresholdCrossed,
} from "./vault";

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

/** How many log lines `/secret log` shows when the operator does not say. */
export const DEFAULT_LOG_LIMIT = 20;

/** A parsed `/secret` invocation. */
export interface SecretCommandRequest {
	subcommand: SecretSubcommand;
	name?: string;
	/** The new name, for `rename`: the second bare word of the line. */
	newName?: string;
	/** Inline credential, when the user supplied one directly. */
	value?: string;
	/** Environment variable to read the credential from. */
	fromEnv?: string;
	scope?: VaultScope;
	/** Lifetime in ms, `null` for never, `undefined` to use the configured default. */
	ttl?: number | null;
	/** How many records `/secret log` shows. */
	limit?: number;
	/**
	 * True when {@link value} came from a masked field rather than the command line.
	 *
	 * Only the confirmation text depends on it: an inline value is in the scrollback and the
	 * confirmation says so, a masked one never was and saying so anyway would teach the operator
	 * to ignore the warning on the occasions it is true.
	 */
	maskedEntry?: boolean;
}

/**
 * The commands that put a credential in the vault that was not there before.
 *
 * TWO OF THEM, because reading a value out of the environment became a command of its own: `add` and
 * `from-env` are one store seen from two entry paths, and every rule about "storing a credential"
 * applies to both. Named here once so a rule cannot be written against `add` alone, which is exactly
 * what happened when `from-env` was split out -- the first-store opt-in kept testing for `add`, so a
 * client storing its first credential through the environment left protection OFF with a secret
 * already in the vault.
 *
 * `value` is NOT one of them. It replaces the value of an entry that already exists, so a store has
 * already happened and whatever the operator decided about protection then still stands.
 */
export const SECRET_ENTRY_COMMANDS: readonly SecretSubcommand[] = ["add", "from-env"];

/**
 * Whether this request needs a credential the operator has not supplied yet.
 *
 * The signal an interactive surface acts on: `true` means open a masked field rather than
 * refusing. Asked HERE, not in the TUI handler, so the text-mode and TUI paths cannot disagree
 * about when a prompt is warranted, and so the rule is testable without a terminal.
 */
export function needsValuePrompt(request: SecretCommandRequest): boolean {
	return (
		(request.subcommand === "add" || request.subcommand === "value") &&
		request.value === undefined &&
		request.fromEnv === undefined
	);
}

/** What the caller should do after the command ran. */
export interface SecretCommandResult {
	/** Text for the operator. Never contains a credential. */
	message: string;
	/**
	 * A note to put in front of the model, when one is warranted.
	 *
	 * Set after a successful `add` so the agent learns that a credential exists and how to
	 * reference it. Without this the model has a placeholder it was never introduced to: the
	 * system prompt's note about `#XXXX#` tokens is folded in at startup, so a session that
	 * began with no secrets would never have been told what one means.
	 *
	 * Also set by `rm` and `extend`, because the vault changing under a conversation is invisible
	 * to the model otherwise. The absence of a name is a weak signal: after a revocation the model
	 * still has "use `#NAME#`" in its history and keeps emitting it, and the placeholder no longer
	 * expands, so what actually reaches the shell is the literal text.
	 */
	agentNotice?: string;
	/**
	 * True when {@link agentNotice} revokes a placeholder rather than offering one.
	 *
	 * The distinction decides whether the notice survives protection being off. A notice that
	 * advertises a usable placeholder is false in that state and must be withheld; a notice that
	 * says "stop using this" is true in every state and is needed most precisely there, because
	 * with nothing expanding, every `#NAME#` the model writes reaches the shell verbatim.
	 */
	agentNoticeIsRevocation?: true;
	/**
	 * Text the surface should put on the clipboard, set by `copy`.
	 *
	 * A PLACEHOLDER, never a value. This layer is pure logic over a vault and owns no clipboard, and
	 * the only thing worth copying is the token the model spends, which is not a credential: it can
	 * be printed, pasted and shared freely, which is the whole reason it exists.
	 */
	copyText?: string;
	/** True when the vault changed, so the caller can refresh the obfuscator. */
	changed: boolean;
}

/** The two command-help surfaces have different safe credential-entry capabilities. */
export type SecretCommandSurface = "tui" | "noninteractive";

/**
 * The credential-entry lines, which are the ONLY thing the two help surfaces disagree about.
 *
 * Named once rather than written out twice, because that disagreement is a security property:
 * a surface with no way to hide what is typed must never advertise typing a credential. Two
 * hand-maintained lists drift, and the drift that matters here is silent — an ACP client
 * offered a masked prompt it cannot open, or an inline form that would park the credential in
 * its request history forever.
 *
 * BOTH SURFACES LEAD WITH THE VERB, and what differs is only where the value may come from. The
 * terminal can hide what is typed, so it offers the masked field and the inline value; a client
 * that cannot hide anything is offered the environment variable and a name to file it under.
 *
 * THREE LINES, DOWN FROM FOUR. The terminal's list used to open with `/secret <value>`, a form with
 * no verb at all, which then needed a separate escape line for a value whose first word collided
 * with a verb. With the value living behind `add`, the escape IS the ordinary form: `/secret add
 * list` stores the credential `list`, and there is nothing left to explain.
 */
const USAGE_TUI_MASKED = "/secret add                           paste into a hidden field";
const USAGE_TUI_INLINE = "/secret add <value>                   store it now, then name it (optional)";
const USAGE_TUI_FROM_ENV = "/secret from-env <VAR> [<name>]       store the value of an environment variable";
const USAGE_ADD_FROM_ENV = "/secret from-env <VAR> <name>         store the value of an environment variable";
/**
 * The one line in a help text that describes a REFUSAL, and it is here because the refusal is what a
 * client operator will meet: `add` is declared, so it appears in the ACP command listing, and it is
 * the word anybody reaches for first. Leaving it out of this text left the listing advertising a
 * command whose only documentation was the error it returns.
 */
const USAGE_CLIENT_ADD = "/secret add                           not here: a client cannot hide typing, so use from-env";

/**
 * What each command reads after its own word: the slots it fills, in order, and the trailing words
 * it will recognise wherever they appear.
 *
 * THERE ARE NO OPTIONS. Every argument is a plain word, and a word gets its meaning from exactly one
 * of two places, never from a third:
 *
 *   1. THE POSITION it sits in. A required slot takes whatever word arrives there, so a value that
 *      happens to read like a keyword is still read correctly: `/secret rm PROFILE` removes the
 *      secret named PROFILE, because position 1 of `rm` is a name and nothing else.
 *   2. A CLOSED SET OR SHAPE it belongs to, for the trailing words that may be omitted or reordered.
 *      A vault is one of exactly three words; a lifetime is what `isTtlWord` recognises; a limit is a
 *      whole number.
 *
 * Type-detection is allowed ONLY where the token sets provably cannot overlap, and each such slot
 * says below why they cannot. Where they could overlap, position decides instead. That is the whole
 * disambiguation story, and it is short on purpose: the grammar this replaced had a third source of
 * meaning -- a leading `--` marking a word as syntax -- and every hazard in this file's history came
 * from a credential that happened to look like syntax.
 *
 * THIS TABLE IS THE NONINTERACTIVE GRAMMAR. The two commands that take a VALUE differ by surface,
 * because only a terminal can hide what is typed, and both are handled in the surface branch of
 * `parseSecretCommand` before this table is consulted. Everything else parses identically on both.
 *
 * EXPORTED so the grammar suites can be derived from it rather than restating it. A hand-written
 * copy of this table in a test goes stale the moment a command is added, and a stale copy is the same
 * thing as no test: the new command's slots are then asserted by nobody.
 *
 * `needsScope` is REQUIRED on every entry, and it stays explicit rather than derived from a `scope`
 * slot. Three commands refuse a request with no vault instead of defaulting one, and each refuses
 * with its own sentence explaining why there is no default; a derived flag would still refuse on
 * arity but would lose the reason, which is the only part an operator can act on.
 */
export type SecretSlot = "name" | "newName" | "variable" | "scope" | "ttl" | "limit";

export const SECRET_SUBCOMMAND_SHAPES: Record<
	SecretSubcommand,
	{ slots: readonly SecretSlot[]; required: number; trailing: readonly SecretSlot[]; needsScope: boolean }
> = {
	// Surface-split, and the table describes neither half: in a terminal everything after `add` is
	// the credential, and on a client that cannot hide typing there is no value to read at all, so
	// `add` there is refused and told to use `from-env`.
	add: { slots: [], required: 0, trailing: [], needsScope: false },
	// THE VARIABLE FIRST, THEN THE NAME, both required on this surface, so both are read by POSITION.
	// That is what lets a secret be called PROFILE or NEVER: a trailing-word reading of the name would
	// hand those two words to the vault slot and the lifetime slot instead, and the operator could
	// never name a secret after one of them. The lifetime and the vault come after and may be given
	// in either order, because a lifetime word and a vault word cannot be the same word.
	"from-env": { slots: ["variable", "name"], required: 2, trailing: ["ttl", "scope"], needsScope: false },
	list: { slots: [], required: 0, trailing: [], needsScope: false },
	// OPTIONAL vault, unlike `clear`. Omitted, removal takes the narrowest match, which is the entry
	// currently in effect and so the one the operator means almost every time. Named, it removes from
	// that vault only. Without it a name held in two vaults had its outer copy stranded: every `rm`
	// took the inner one, and there was no way to reach the other.
	rm: { slots: ["name"], required: 1, trailing: ["scope"], needsScope: false },
	// REQUIRED vault, at position 1 rather than trailing, because `clear` takes no name: there is
	// nothing else a bare word after it could mean. This one empties a vault that reads perfectly
	// well, and there is no narrowest-wins default to fall back on -- "the vault" is three files and
	// the operator can only mean one of them.
	clear: { slots: ["scope"], required: 1, trailing: [], needsScope: true },
	// TWO words: the name, then the new name. The second is a name and not a credential, so it is
	// read off the line where `add`'s never is, and a third word is still refused.
	rename: { slots: ["name", "newName"], required: 2, trailing: [], needsScope: false },
	// ONE word, and the replacement arrives the way a credential always does: from a masked field, or
	// out of the environment as the trailing pair `from-env <VAR>`. That pair is a keyword and a word
	// because a variable name is arbitrary text and cannot be recognised by shape -- and `from-env`
	// cannot be mistaken for a secret name, since a name may not contain a hyphen.
	value: { slots: ["name"], required: 1, trailing: ["variable"], needsScope: false },
	// TWO words: the name, then the destination vault. The destination is position 2 rather than a
	// trailing word, because on this command it is the entire point of the line.
	scope: { slots: ["name", "scope"], required: 2, trailing: [], needsScope: true },
	copy: { slots: ["name"], required: 1, trailing: [], needsScope: false },
	// TWO words: the name, then the lifetime. Required, so position decides, which is what lets a
	// secret named NEVER have its lifetime extended.
	extend: { slots: ["name", "ttl"], required: 2, trailing: [], needsScope: false },
	// BOTH TRAILING AND BOTH OPTIONAL, in either order, which is the one place a name is recognised
	// by shape rather than by position. It is safe because the two sets cannot overlap: a limit is a
	// whole number, and a secret name may not begin with a digit, so no word is both. `/secret log 50`
	// is fifty records and `/secret log GITHUB_TOKEN` is one secret's uses.
	log: { slots: [], required: 0, trailing: ["name", "limit"], needsScope: false },
	// REQUIRED vault at position 1, for `clear`'s reason and a sharper one: the vault names a FILE to
	// move aside rather than a place to store something, so discarding one nobody named would move a
	// working vault out from under the session.
	discard: { slots: ["scope"], required: 1, trailing: [], needsScope: true },
	help: { slots: [], required: 0, trailing: [], needsScope: false },
};

/**
 * Everything you only need once a secret exists, shared by both surfaces.
 *
 * ONE LIST, because both surfaces parse all of it. Every capability `/secret` has is a word in this
 * list, including rename, value, scope and copy, which is what makes the list the feature rather
 * than a summary of a screen the operator has to find first.
 */
const USAGE_LIST = "/secret list                          show active secrets, never their values";
const USAGE_MANAGE = [
	USAGE_LIST,
	"/secret rm <name> [global]            remove a secret",
	"/secret clear profile                 remove every secret in one vault",
	"/secret rename <name> <new-name>      give a secret a different name",
	"/secret value <name>                  replace a secret's value, keeping its name and lifetime",
	"/secret scope <name> global           move a secret to another vault",
	"/secret copy <name>                   copy #NAME#, the placeholder, never the value",
	"/secret extend <name> 7d              give a secret a fresh lifetime",
	"/secret log [<name>] [50]             show which secrets were used, and where",
	"/secret discard project               move a broken vault file aside",
];

/**
 * What the two recognised word-shapes are, and which commands read them.
 *
 * Named per shape with its readers rather than as a block that opens with "Options:". A word is not
 * an option: `7d` means a lifetime on the two commands that take one and is an extra word everywhere
 * else, and advertising it as universal would promise a reading the parser then refuses, which reads
 * as a bug rather than as a rule.
 *
 * ONE FOOTER FOR BOTH SURFACES, because the commands it annotates parse on both. The surfaces differ
 * in how a VALUE is entered, which is why the entry lines above it differ, and in nothing else.
 */
const USAGE_FOOTER_SCOPES =
	"Lifetimes default to the secrets.defaultTtl setting. Scope defaults to profile; project overrides profile, which overrides global.";

/**
 * The annotation column is padded to a fixed width so each shape and its commands line up. Built
 * rather than written out, because the command half is derived: a hand-written sentence naming the
 * readers of the vault word went stale in the same commit that added a fourth one.
 */
const footerShape = (shape: string, tail: string): string => `${shape.padEnd(37)}${tail}`;

const USAGE_FOOTER = [
	footerShape("30m|12h|7d|2w|never", `a lifetime, on ${joinWithAnd(subcommandsWithSlot("ttl"))}`),
	footerShape("profile|project|global", `a vault, on ${joinWithAnd(subcommandsWithSlot("scope"))}`),
	USAGE_FOOTER_SCOPES,
	"Removal without a vault takes the narrowest match, which is the one currently in effect.",
];

/**
 * Two spaces in front of every line `/secret` indents: usage entries, `list` table rows, the
 * suggestions an empty vault prints. ONE owner, so the command's output reads as one report
 * rather than three that nearly line up.
 */
const OUTPUT_INDENT = "  ";

/**
 * What a value typed on the command line costs, said in the confirmation that stores it.
 *
 * ONE OWNER, because `add` and `value` both accept an inline credential and both have to say the
 * same thing about it: the obfuscator protects what goes to a provider and cannot retroactively
 * scrub a terminal, so the bytes are in the scrollback until the operator clears it.
 */
const SCROLLBACK_WARNING =
	"The value was typed on screen, so it is in your scrollback. Use /secret from-env next time to avoid that.";

/**
 * Help, grouped: what you do every day first, management second.
 *
 * The flat list this replaced gave `rm`, `extend` and `log` exactly the weight of `add`, so the
 * one line a new operator needs was the fourth of seven with nothing separating them. Both
 * surfaces are built from the same call, so the grouping cannot be applied to one and forgotten
 * on the other.
 */
function buildUsage(
	entryLines: readonly string[],
	manageLines: readonly string[],
	footerLines: readonly string[],
): string {
	const groups: ReadonlyArray<readonly [string, readonly string[]]> = [
		["Store a credential the agent can use without ever seeing it:", entryLines],
		["Manage what is already stored:", manageLines],
	];
	const lines: string[] = [];
	for (const [heading, entries] of groups) {
		// The blank line after each group is what makes the grouping visible at all.
		lines.push(heading, ...entries.map(entry => `${OUTPUT_INDENT}${entry}`), "");
	}
	lines.push(...footerLines);
	return lines.join("\n");
}

/** TUI help leads with the three ways `add` takes a value, then every verb the terminal parses. */
export const SECRET_COMMAND_USAGE = buildUsage(
	[USAGE_TUI_MASKED, USAGE_TUI_INLINE, USAGE_TUI_FROM_ENV],
	USAGE_MANAGE,
	USAGE_FOOTER,
);

/** Noninteractive help exposes only environment-backed creation and the text management verbs. */
export const NONINTERACTIVE_SECRET_COMMAND_USAGE = buildUsage(
	[USAGE_ADD_FROM_ENV, USAGE_CLIENT_ADD],
	USAGE_MANAGE,
	USAGE_FOOTER,
);

/** Select help that matches what the invoking surface can enter safely. */
export function secretCommandUsage(surface: SecretCommandSurface): string {
	return surface === "tui" ? SECRET_COMMAND_USAGE : NONINTERACTIVE_SECRET_COMMAND_USAGE;
}

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

/**
 * The dash-shaped tokens this grammar still mentions, and it mentions them in order to refuse them.
 *
 * Every one of them meant something one release ago: `--` ended the options and `--from-env`, `--ttl`,
 * `--scope`, `--limit` and `--name` were the options it ended. There are none now, because every
 * argument is a plain word, so nothing after `add` is ever syntax and nothing needs terminating.
 *
 * THEY ARE REFUSED, NOT STORED, and that is the only reason they appear here at all. The value reader
 * below takes the line byte for byte, so forgetting them would store `-- ghp_...` with the dashes
 * welded to the front, or store the literal text `--from-env MY_TOKEN` as somebody's API token while
 * telling them it was read out of the environment. `#NAME#` would then expand to those bytes and the
 * failure would surface much later as an authentication error nobody could trace to a slash command. A
 * credential is exactly the input whose corruption stays invisible until it is spent, so a spelling
 * that meant something one release ago fails closed instead.
 *
 * ONLY AN EXACT MATCH ON THE FIRST WORD. A value that merely begins with dashes -- `--abc`, or a
 * private key's `-----BEGIN` -- is just bytes and is stored verbatim, and so is a line whose SECOND
 * word is one of these, since by then the credential has already begun.
 */
const REMOVED_OPTION_SPELLINGS: readonly string[] = ["--", "--from-env", "--ttl", "--scope", "--limit", "--name"];

/** One whitespace-delimited word of an argument line, with the offsets its slice needs. */
interface SecretToken {
	value: string;
	start: number;
	end: number;
}

/**
 * Read what follows `/secret add` in a terminal as the credential.
 *
 * REACHED FROM ONE PLACE, and it reads ONE thing. It used to also recognise a leading `--from-env`,
 * which made this function two grammars: a flag reading and a value reading of the same bytes, told
 * apart by a dash. `from-env` is a command of its own now, decided before any value is read, so
 * everything that arrives here is the credential and there is nothing left to disambiguate.
 */
function parseTuiValue(args: string, tokens: readonly SecretToken[]): SecretCommandRequest {
	if (tokens.length === 0) return { subcommand: "add" };

	const removed = tokens[0].value;
	if (REMOVED_OPTION_SPELLINGS.includes(removed)) {
		throw new Error(
			`${removed} is not part of /secret, and the rest of the line was not stored in case those bytes ` +
				`were meant to be read rather than kept. /secret takes plain words and no options: write ` +
				`/secret from-env <VAR> to read a value out of the environment, /secret add <value> for a value ` +
				`whose first word is a command word, or /secret add on its own to paste into a hidden field.`,
		);
	}

	// Sliced from the first token's start to the last one's end, rather than trimmed: that drops
	// the whitespace a terminal adds around what was typed while preserving, byte for byte, any
	// whitespace INSIDE the credential. A passphrase is allowed to contain spaces.
	return { subcommand: "add", value: args.slice(tokens[0].start, tokens[tokens.length - 1].end) };
}

/**
 * Parse a `/secret` argument line.
 *
 * Throws on anything it cannot read rather than guessing, because every guess here is about a
 * credential's name, lifetime, or visibility.
 */
export function parseSecretCommand(args: string, surface: SecretCommandSurface = "tui"): SecretCommandRequest {
	const usageText = secretCommandUsage(surface);
	const tokens = [...args.matchAll(/\S+/gu)].map(match => ({
		value: match[0],
		start: match.index,
		end: match.index + match[0].length,
	}));

	// A COMMAND COMES FIRST, ON BOTH SURFACES. `/secret <verb> [value]`, and a first word that is not
	// a verb is not anything: it is refused, and nothing is stored.
	//
	// The terminal used to read any unreserved line as the credential itself, so `/secret ghp_x`
	// stored a token with no verb at all. It cost one paste, and it cost the grammar everything else:
	// a typo was a credential (`/secret lst` stored the string `lst` and switched protection on), so
	// every word the command might ever want had to be reserved in advance to keep a mistyped verb
	// from becoming an entry, and the collision that reserving created then needed an escape of its
	// own. One line of grammar, three mechanisms to contain it. Requiring the verb deletes all three:
	// nothing collides, because a value is only ever read after `add`.
	if (surface === "tui" && tokens.length > 0) {
		const leading = SECRET_VERB_SPELLINGS[tokens[0].value.toLowerCase()];
		// `add` is NOT the noninteractive `add <name>`. The terminal never takes a name inline: the
		// name is asked afterwards, and a name parsed off this line would be a credential written to
		// the vault's plaintext metadata and echoed back on screen, which is exactly how
		// `/secret add ghp_realToken` once filed a live token AS a name.
		if (leading === "add") return parseTuiValue(args, tokens.slice(1));
	}

	if (tokens.length === 0) return { subcommand: "help" };

	const subcommand = SECRET_VERB_SPELLINGS[tokens[0].value.toLowerCase()];
	if (subcommand === undefined) {
		// THE WORD IS NOT REPEATED. An unknown first token is most often a credential: someone typed
		// `/secret ghp_…` from muscle memory, and echoing it would write the credential into the
		// refusal, the scrollback and the saved transcript. The usage below is the actionable half
		// anyway, because it names every word this surface does run.
		//
		// AND IT SAYS THE LINE IS EXPOSED, on the surface that used to store it. A terminal accepted
		// exactly this line as a credential once: it stored the value and protected it. Refusing is
		// the right answer now, but it leaves the operator worse off than either outcome they might
		// expect -- nothing is stored, AND the credential is sitting in the scrollback of a session
		// that will not obfuscate it, because the vault never saw it. Silence there is the failure
		// mode of the whole feature: a credential believed stored, unprotected, and pasted onward. It
		// does not warn the noninteractive surface, which never had the verbless form to unlearn, and
		// where the tail of the line is a client's own argv rather than something a person just typed.
		const exposure =
			surface === "tui"
				? ` Nothing was stored. If what followed /secret was a credential, it is now in your ` +
					`scrollback and was never protected, so rotate it and store the new one with /secret add.`
				: "";
		throw new Error(`Unknown /secret command.${exposure}\n\n${usageText}`);
	}

	const request: SecretCommandRequest = { subcommand };
	const shape = SECRET_SUBCOMMAND_SHAPES[subcommand];
	const words = tokens.slice(1).map(token => token.value);

	// `add` WITH ANYTHING AFTER IT, ON A CLIENT, IS A CREDENTIAL IN A REQUEST LOG, and it gets its own
	// sentence rather than the generic extra-word refusal below. It is the line an RPC or ACP client
	// actually sends -- `/secret add NAME ghp_...`, the spelling this grammar had one release ago -- so
	// the answer has to say what happened to the credential and where to put it instead, not merely
	// that a word could not be read.
	//
	// NEITHER WORD IS ECHOED, including the name. On the terminal surface the name is the one word that
	// is safe to repeat, because the value went into a field; here the two arrived in the same
	// position-free tail and nothing distinguishes `add NAME secret` from `add secret`. Repeating
	// either would write a credential into the client's error log, which is the exposure the refusal
	// exists for.
	if (surface === "noninteractive" && subcommand === "add" && words.length > 0) {
		throw new Error(
			`This client refuses an inline credential, because the line carrying it is retained in the ` +
				`client's own request history. Nothing was stored. Read the value out of the environment ` +
				`instead: /secret from-env MY_TOKEN <name>.\n\n${usageText}`,
		);
	}
	// A TERMINAL ASKS FOR THE NAME AFTERWARDS, so `from-env <VAR>` is a complete line there and the
	// name slot is optional. It is the ONE slot whose necessity depends on the surface, and it depends
	// on it for a reason that is about the surface and not about the grammar: a client has no field to
	// ask in, so a name it does not write is a name nothing can supply.
	//
	// Optional is not absent. `from-env VAR MY_TOKEN 7d project` reads the same on both surfaces, which
	// is what keeps the two spellings one grammar rather than two: the terminal may leave the name out,
	// not spell it differently. The optional slot yields to a recognised trailing word, so `from-env
	// VAR project` names a vault and leaves the name to the field. A secret the operator wants called
	// PROFILE is therefore typed into the field rather than onto this line, which the field exists for.
	const required = surface === "tui" && subcommand === "from-env" ? 1 : shape.required;

	let index = 0;
	// POSITIONAL SLOTS FIRST, in the order the table declares them.
	//
	// A REQUIRED slot takes whatever word arrives, without consulting its shape. That is the rule that
	// lets a credential be named PROFILE and a lifetime be extended on a secret called NEVER: position
	// decides, so a name that reads like a vault or a lifetime is still a name.
	//
	// An OPTIONAL slot yields to a trailing word it recognises, because the alternative is worse: with
	// `from-env VAR 7d` the name slot would swallow `7d`, and the operator would be told `7D` is not a
	// valid secret name rather than being given a one-week lifetime.
	for (const slot of shape.slots) {
		if (index >= words.length) break;
		if (index >= required && matchTrailing(shape.trailing, words[index]) !== undefined) break;
		assignSlot(request, slot, words, index, usageText);
		index += 1;
	}

	if (index < required) {
		// A MISSING VAULT KEEPS ITS OWN SENTENCE. `clear` and `discard` read the vault as their first
		// word, so a bare line is arity-missing before it is scope-missing, and the generic refusal below
		// would answer "still needs a vault" without the half that matters: WHY there is no default. That
		// reason is per-command and it is the whole reason these two refuse instead of guessing.
		refuseMissingScope(request, usageText);
		throw refuseMissingWords(subcommand, shape, required, index, usageText);
	}

	// THEN THE TRAILING WORDS, in any order, each recognised by its own shape. A word that fits no
	// remaining slot is REFUSED rather than ignored: an ignored word looks applied, which is how
	// `/secret log 50` used to print twenty records and say nothing about the fifty.
	const filled = new Set<SecretSlot>();
	while (index < words.length) {
		const slot = matchTrailing(shape.trailing, words[index]);
		if (slot === undefined) throw refuseExtraWord(request, shape, index, words, surface, usageText);
		// A SECOND WORD FOR A SLOT THAT IS FILLED IS NEVER THE ONE THAT WINS. Last-one-wins on a
		// lifetime or a vault would store a credential somewhere the operator did not read on their own
		// line, and first-one-wins would ignore what they wrote last, which is the reading they meant.
		if (filled.has(slot)) throw refuseRepeatedWord(subcommand, slot, surface, usageText);
		filled.add(slot);
		// `variable` is the one trailing slot spelled as two words, `from-env <VAR>`, because a variable
		// name is arbitrary text with no shape to recognise. The keyword is consumed here and the word
		// after it is the value.
		if (slot === "variable") {
			const variable = words[index + 1];
			if (variable === undefined) {
				throw new Error(
					`/secret ${subcommand} from-env needs the name of an environment variable after it.\n\n${usageText}`,
				);
			}
			request.fromEnv = variable;
			index += 2;
			continue;
		}
		assignSlot(request, slot, words, index, usageText);
		index += 1;
	}

	refuseMissingScope(request, usageText);
	return request;
}

/**
 * Which trailing slot a word belongs to, or `undefined` when it belongs to none.
 *
 * THE ONLY PLACE A WORD'S SHAPE DECIDES ANYTHING, and every set it tests is disjoint from every
 * other by construction rather than by luck:
 *
 *   - a vault is one of exactly three literals;
 *   - a lifetime is what `isTtlWord` recognises, which is `never` or digits followed by one unit
 *     letter, and none of those is a vault word;
 *   - a limit is digits only, and a lifetime always ends in a letter, so no word is both;
 *   - `from-env` introduces a variable and can never be a secret name, because a name may not contain
 *     a hyphen;
 *   - a NAME is whatever is left, and it is only ever a trailing slot on `log`, where the sole other
 *     trailing slot is a limit. A secret name may not begin with a digit, so a bare number is a limit
 *     and anything else is a name, with no word satisfying both.
 *
 * Order matters within this function and not between callers: the specific shapes are tested before
 * the catch-all name, so `log 50` is a limit rather than a secret called 50.
 */
function matchTrailing(trailing: readonly SecretSlot[], word: string): SecretSlot | undefined {
	const lower = word.toLowerCase();
	if (trailing.includes("scope") && (lower === "profile" || lower === "project" || lower === "global")) {
		return "scope";
	}
	if (trailing.includes("limit") && /^[0-9]+$/.test(word)) return "limit";
	// A NEAR MISS IS STILL A LIFETIME. `isTtlWord` alone would send `7dd` and `50` to the generic
	// "this word fits no slot" refusal, which tells the operator nothing about the unit they fumbled.
	// Any word beginning with a digit is claimed here, because nothing else can be one: a limit is
	// digits only and is tested above, a vault is one of three words, and a secret name may not begin
	// with a digit. `parseTtl` then owns the wording for every way a lifetime can be wrong.
	if (trailing.includes("ttl") && (isTtlWord(word) || /^[0-9]/.test(word))) return "ttl";
	if (trailing.includes("variable") && lower === "from-env") return "variable";
	if (trailing.includes("name")) return "name";
	return undefined;
}

/**
 * Read one word into the slot it fills, refusing a word the slot cannot hold.
 *
 * Every refusal here is about a word the operator DID mean as syntax, so these may name the word's
 * position and its permitted values. None of them repeats the word: a misplaced credential reaches
 * this function too, and the one command whose purpose is keeping credentials off the screen must not
 * write one into an error that lands in the scrollback and the saved transcript.
 */
function assignSlot(
	request: SecretCommandRequest,
	slot: SecretSlot,
	words: readonly string[],
	index: number,
	usageText: string,
): void {
	const word = words[index];
	switch (slot) {
		case "name":
			// Normalised only where the value is compared against stored names. `log` filters the audit
			// record by name, so it has to match what was written; every other command hands the word to
			// the vault, which resolves it and owns that rule.
			request.name = request.subcommand === "log" ? normaliseSecretName(word) : word;
			return;
		case "newName":
			request.newName = word;
			return;
		case "variable":
			request.fromEnv = word;
			return;
		case "scope": {
			const scope = word.toLowerCase();
			if (scope !== "profile" && scope !== "project" && scope !== "global") {
				throw new Error(
					`Which vault? Write profile, project or global. The word you wrote is not repeated here, ` +
						`in case it is the credential.\n\n${usageText}`,
				);
			}
			request.scope = scope;
			return;
		}
		case "ttl":
			// No try/catch. `parseTtl` owns the wording for every way a lifetime can be wrong and does not
			// echo the value, so a lifetime typed here and one typed anywhere else explain the same
			// mistake the same way.
			request.ttl = parseTtl(word);
			return;
		case "limit": {
			const limit = Number(word);
			// SAFE integer, not merely integral. `matchTrailing` only routes digits here, so this cannot be
			// NaN, and `Number.isInteger` accepts 1e21: twenty-two digits parse to an integral float that
			// no longer counts records, and `slice(-1e21)` silently returns the whole log. A count the
			// arithmetic cannot represent is refused rather than honoured as something else.
			if (!Number.isSafeInteger(limit) || limit <= 0) {
				throw new Error(`How many records? Write a positive whole number, such as /secret log 50.`);
			}
			request.limit = limit;
			return;
		}
	}
}

/**
 * Refuse a command whose required words are not all there.
 *
 * NAMES WHAT IS MISSING BY SLOT, because "wrong number of arguments" leaves the operator counting.
 * The slot names are the ones the usage line uses, so the refusal and the line under it agree word
 * for word.
 *
 * It cannot echo the words that DID arrive: on a `/secret` line a word in the wrong place is very
 * often the credential, and this is the command whose whole purpose is keeping credentials out of the
 * scrollback and the saved transcript.
 */
function refuseMissingWords(
	subcommand: SecretSubcommand,
	shape: (typeof SECRET_SUBCOMMAND_SHAPES)[SecretSubcommand],
	required: number,
	got: number,
	usageText: string,
): Error {
	const missing = shape.slots.slice(got, required).map(slot => SLOT_WORDS[slot]);
	return new Error(
		`/secret ${subcommand} still needs ${joinWithAnd(missing)}. The words already on the line are not ` +
			`repeated here, in case one of them is the credential.\n\n${usageText}`,
	);
}

/**
 * Refuse a second word for a slot that is already filled.
 *
 * Its own sentence, rather than the generic extra-word refusal, because the mistake is different and
 * so is the fix: the operator wrote two lifetimes or two vaults and has to decide which one they
 * meant. It names the slot and not either word, since one of the two may be the credential.
 */
function refuseRepeatedWord(
	subcommand: SecretSubcommand,
	slot: SecretSlot,
	surface: SecretCommandSurface,
	usageText: string,
): Error {
	return new Error(
		`/secret ${subcommand} reads ${SLOT_WORDS[slot]} once, and this line names one twice. Neither word is ` +
			`repeated here, in case one is the credential: write the line again with the one you meant.` +
			`${valueFormHint(surface)}\n\n${usageText}`,
	);
}

/**
 * The second reading of every over-long terminal line, offered in one place.
 *
 * A line with a word too many on it is either a mistake or a credential that begins with a command
 * word, and the operator who meant the second thing has to be told the one spelling that expresses
 * it. Both refusals below carry it, because both are reached by exactly that line: `/secret log TOKEN
 * ghp_...` is a repeated name, `/secret rm TOKEN ghp_...` is a word that fits no slot, and the
 * operator's mistake is the same one.
 *
 * NOT ON A CLIENT, which has no bare-value form to reach for: there the sentence would advertise an
 * entry path the surface refuses.
 */
function valueFormHint(surface: SecretCommandSurface): string {
	return surface === "tui"
		? ` If the whole line is itself a credential that begins with a command word, store it with ` +
				`/secret add <value>.`
		: "";
}

/** What each slot is called in a refusal, matching the placeholders in the usage lines. */
const SLOT_WORDS: Record<SecretSlot, string> = {
	name: "a secret name",
	newName: "the new name",
	variable: "an environment variable name",
	scope: "a vault (profile, project or global)",
	ttl: "a lifetime such as 7d",
	limit: "a number of records",
};

/**
 * Refuse a word that fits no remaining slot.
 *
 * IGNORING IT IS THE BUG THIS EXISTS TO PREVENT, in the shape people actually type: `/secret log 50`
 * used to parse the `50` into `request.name`, which `showLog` does not read, so the command printed
 * the default twenty records and said nothing about the fifty. The operator concludes twenty is all
 * there is. A word that looks applied and is not is worse than a refusal.
 *
 * IT DOES NOT QUOTE THE WORD. The realistic slip is muscle memory for `add` under a different
 * command -- `/secret extend TOK sk-live-...`, `/secret rm TOK sk-live-...`, a value appended to
 * `/secret list` -- so the extra word is very often the credential itself, and quoting it wrote that
 * credential into an error that lands in the scrollback and in the saved transcript permanently.
 * Naming the POSITION says what to remove without repeating the secret back.
 *
 * IN A TERMINAL IT ALSO NAMES THE VALUE FORM, because the second reading of every one of those lines
 * is "this is a credential that starts with a command word", and the operator who meant that has to
 * be told the one spelling that expresses it. Not on the noninteractive surface, where a value
 * arrives through `from-env` and there is no bare-value form to reach for.
 */
function refuseExtraWord(
	request: SecretCommandRequest,
	shape: (typeof SECRET_SUBCOMMAND_SHAPES)[SecretSubcommand],
	index: number,
	words: readonly string[],
	surface: SecretCommandSurface,
	usageText: string,
): Error {
	const readable = shape.trailing.map(slot => SLOT_WORDS[slot]);
	// Digits are the one shape that cannot be a credential worth protecting AND is the shape the hint
	// needs to be useful, so `/secret rm TOK 50` can still say what a bare number would have meant.
	const counted = /^[0-9]+$/.test(words[index]) ? words[index] : undefined;
	const tail =
		readable.length > 0
			? ` After the required words /secret ${request.subcommand} reads ${joinWithAnd(readable)}, in any order, once each.`
			: ` /secret ${request.subcommand} reads no further words.`;
	const hint =
		counted !== undefined && request.subcommand !== "log" ? ` A bare number is only read by /secret log.` : "";
	const valueHint = valueFormHint(surface);
	const position = index === 0 ? "the first word after the command" : `the word in position ${index + 1}`;
	return new Error(
		`/secret ${request.subcommand} cannot read ${position}, and a word that would be ignored is refused ` +
			`rather than dropped silently. The word itself is not repeated here, in case it is the ` +
			`credential.${tail}${hint}${valueHint}\n\n${usageText}`,
	);
}

/**
 * Refuse a command that needs a vault and was given none, rather than defaulting one.
 *
 * EVERY OTHER PLACE a vault word appears names where to PUT something and defaults to profile, where
 * a wrong guess costs you a secret stored in the wrong place and `/secret list` shows you that. The
 * three commands below select something that already exists -- a file to move aside, a vault to
 * empty, a destination to move a secret into -- so a default acts on whichever one happened to be in
 * front.
 *
 * WHICH commands those are is read from `SECRET_SUBCOMMAND_SHAPES.needsScope` rather than from this
 * chain, so the grammar suites and this guard cannot hold different lists. The sentences stay
 * per-command because the reason differs, and a command that declares the requirement without one is
 * still refused rather than quietly allowed.
 */
function refuseMissingScope(request: SecretCommandRequest, usageText: string): void {
	if (!SECRET_SUBCOMMAND_SHAPES[request.subcommand].needsScope || request.scope !== undefined) return;
	if (request.subcommand === "scope") {
		throw new Error(
			`/secret scope needs the vault to move the secret INTO, such as /secret scope MY_TOKEN global. ` +
				`There is no default: the vault it is already in is the one answer that cannot be meant.` +
				`\n\n${usageText}`,
		);
	}
	if (request.subcommand === "clear") {
		throw new Error(
			`/secret clear needs the vault to empty, such as /secret clear profile. There is no ` +
				`default: a credential you can reach is the narrowest copy of it, so a guessing /secret clear ` +
				`would empty whichever vault happens to be in front and leave the other two full.` +
				`\n\n${usageText}`,
		);
	}
	if (request.subcommand === "discard") {
		throw new Error(
			`/secret discard needs the vault whose file you want moved aside, such as ` +
				`/secret discard project. There is no default, because discarding a vault you did ` +
				`not mean would move a working file out from under this session.\n\n${usageText}`,
		);
	}
	// Declared as needing a vault, with no sentence written for it. Refusing generically is the only
	// safe reading: accepting the request would act on a vault the operator never named.
	throw new Error(
		`/secret ${request.subcommand} needs the vault to act on, such as ` +
			`/secret ${request.subcommand} profile. There is no default.\n\n${usageText}`,
	);
}

/**
 * Which commands read a slot, in table order.
 *
 * ONE OWNER for a fact that had two: the refusal sentences derived it from the shape table while the
 * usage footer stated it as prose ("on add, rm and discard"), so a command that gained a vault word
 * moved one and left the other describing a surface that no longer existed. The footer is built from
 * this, which is also why it returns bare command names and lets each caller add its own prefix.
 *
 * Both slot lists are searched. A vault is a required word on `clear` and a trailing one on `rm`, and
 * the footer line that says which commands take a vault is wrong if it names only one of them.
 */
function subcommandsWithSlot(slot: SecretSlot): SecretSubcommand[] {
	return (Object.keys(SECRET_SUBCOMMAND_SHAPES) as SecretSubcommand[]).filter(
		candidate =>
			SECRET_SUBCOMMAND_SHAPES[candidate].slots.includes(slot) ||
			SECRET_SUBCOMMAND_SHAPES[candidate].trailing.includes(slot),
	);
}

/**
 * "a", "a and b", "a, b and c".
 *
 * Joined by hand rather than with `join(" and ")`, which was correct only while no word-shape was
 * read by more than two commands: the vault word reaching a third turned the sentence into "add and
 * rm and discard". `Intl.ListFormat` would also do this, and is not used because its output moves with
 * locale data, while this string is pinned byte for byte and read by an operator who has just been
 * refused.
 */
function joinWithAnd(items: readonly string[]): string {
	return items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Run a parsed request against a vault. */
export async function runSecretCommand(
	request: SecretCommandRequest,
	context: {
		vault: SecretVault;
		/** Reads an environment variable, injected so tests do not touch the real environment. */
		readEnv: (name: string) => string | undefined;
		/** Configured default lifetime, already parsed. */
		defaultTtl: number | null;
		now: number;
		/** The expansion log, absent when audit recording is turned off. */
		auditLog?: SecretAuditLog;
		/** Help/error copy appropriate for the invoking surface. */
		surface?: SecretCommandSurface;
	},
): Promise<SecretCommandResult> {
	switch (request.subcommand) {
		case "help":
			return { message: secretCommandUsage(context.surface ?? "tui"), changed: false };
		case "add":
		// THE SAME RUNNER. `from-env` is a separate word in the grammar and the same operation in the
		// vault: it stores a credential whose bytes came from the environment instead of from a field.
		// Splitting the runner as well would give two code paths one confirmation, one audit entry and
		// one set of scope rules to keep in step, and nothing about the store differs.
		case "from-env":
			return await addSecret(request, context);
		case "list":
			return await listSecrets(context);
		case "rm":
			return await removeSecret(request, context);
		case "clear":
			return await clearVaultScope(request, context);
		case "extend":
			return await extendSecret(request, context);
		case "log":
			return await showLog(request, context);
		case "discard":
			return await discardVaultScope(request, context);
		case "rename":
			return await renameSecret(request, context);
		case "value":
			return await replaceSecretValue(request, context);
		case "scope":
			return await moveSecretScope(request, context);
		case "copy":
			return await copyPlaceholder(request, context);
	}
}

/**
 * Move an unreadable scope's vault file aside, the in-product repair for a broken vault.
 *
 * WHY THIS COMMAND EXISTS. `load()` degrades past a vault whose decrypted payload will not parse so
 * the session still starts, and `remove()` deliberately refuses to touch such a file, which left the
 * operator able to start and unable to fix: `SecretVault.discardUnreadableScope` existed and nothing
 * in the tree called it, so the only real route was deleting the file by hand. A notice that names a
 * repair the product cannot perform is not a repair.
 *
 * REPORTS THE MOVED PATH, always. The vault is renamed rather than deleted because it still holds
 * real entries sealed with a key that is still on disk, so the damage may be a truncated tail with
 * recoverable credentials behind it. That path is the operator's only route back to them, and
 * swallowing it would make a recoverable move indistinguishable from a delete.
 *
 * No `agentNotice`. An unreadable scope was never loaded, so no placeholder the model was told about
 * stops working here; announcing a revocation that did not happen would teach it to ignore the ones
 * that did.
 */
async function discardVaultScope(
	request: SecretCommandRequest,
	context: { vault: SecretVault },
): Promise<SecretCommandResult> {
	// Unreachable through `parseSecretCommand`, which refuses a missing scope. Kept because this
	// function is also reachable from a hand-built request, and a `VaultScope | undefined` must not
	// silently become a scope somebody did not name.
	if (request.scope === undefined) throw new Error("Which vault? /secret discard project");

	const { movedTo } = await context.vault.discardUnreadableScope(request.scope);
	return {
		message:
			`Moved the unreadable ${request.scope} vault to ${sanitizeSingleLine(movedTo)}, so that scope works ` +
			`again. The file still holds your sealed entries, so re-add the secrets it held rather than ` +
			`assuming they are gone.`,
		// The obfuscator has to be rebuilt: a scope's file just stopped existing at the path the
		// loader reads, and until it reloads the session still holds the pre-discard view.
		changed: true,
	};
}

async function addSecret(
	request: SecretCommandRequest,
	context: {
		vault: SecretVault;
		readEnv: (name: string) => string | undefined;
		defaultTtl: number | null;
		now: number;
		surface?: SecretCommandSurface;
	},
): Promise<SecretCommandResult> {
	if (request.fromEnv !== undefined && request.value !== undefined) {
		throw new Error("Give either an environment variable or a value, not both.");
	}

	let value: string;
	let typedOnScreen: boolean;
	if (request.fromEnv !== undefined) {
		value = readEnvCredential(request.fromEnv, context.readEnv);
		typedOnScreen = false;
	} else if (request.value !== undefined) {
		value = request.value;
		typedOnScreen = request.maskedEntry !== true;
	} else {
		// Reached only where there is no terminal to mask. An interactive session opens a hidden
		// field instead (see `needsValuePrompt`). Non-interactive clients deliberately accept only
		// environment-backed entry, so their refusal must not recommend an inline form the adapter
		// will reject.
		if (context.surface === "noninteractive") {
			throw new Error(
				`No value given, and this client cannot prompt for one without showing it. ` +
					`Name an environment variable to read it from:\n` +
					`  /secret from-env MY_TOKEN ${request.name ?? "<name>"}`,
			);
		}
		throw new Error(
			`No value given, and this client cannot prompt for one without showing it. ` +
				`Name an environment variable to read it from:\n` +
				`  /secret from-env MY_TOKEN\n` +
				`or type the value after /secret add, keeping in mind it stays visible in your scrollback.`,
		);
	}

	const ttl = request.ttl === undefined ? context.defaultTtl : request.ttl;
	const entry = await context.vault.add({ name: request.name, value, scope: request.scope, ttl });

	// A replacement is called a replacement. `vault.add` overwrites a same-name entry in the same
	// scope, which is what makes rotating a credential work, but it is the same write as fumbling
	// the name of an existing secret. Saying "Stored" for both means a typo destroys a working
	// credential and the operator is told nothing went wrong.
	const lines = entry.replaced
		? [
				`Replaced ${entry.name} in the ${entry.scope} vault, ${describeTimeLeft(entry, context.now)}.`,
				`The previous value is gone. #${entry.name}# now spends the credential you just stored.`,
			]
		: [
				`Stored ${entry.name} in the ${entry.scope} vault, ${describeTimeLeft(entry, context.now)}.`,
				`The model sees #${entry.name}# and never the value. Write that placeholder where the credential goes.`,
			];
	if (typedOnScreen) {
		// Said plainly rather than left for the user to work out. The obfuscator protects what
		// goes to the provider; it cannot retroactively scrub the terminal.
		lines.push(SCROLLBACK_WARNING);
	}

	return {
		message: lines.join("\n"),
		agentNotice:
			`The user has stored a secret for you to use. Reference it as #${entry.name}# wherever the ` +
			`credential belongs, for example inside a command's arguments. The placeholder is replaced with the ` +
			`real value locally, just before the command runs, so you never see the value itself and must not ` +
			`ask for it. Do not write #${entry.name}# into a file or a message where it is not needed.`,
		changed: true,
	};
}

/** Blank columns between two cells. Two, so adjacent cells never read as one word. */
const LIST_GUTTER = 2;

/**
 * Widest any cell may draw: `#` + a maximum-length name + `#`, so no legal name is ever cut.
 *
 * The cap exists for the name a legal vault cannot hold. This renderer is handed entries, not
 * a validated vault, and a hand-edited file or a wide-character name would otherwise push
 * SCOPE and EXPIRES off the right of the terminal — the unreadable output this table replaced.
 */
const MAX_LIST_CELL_WIDTH = MAX_SECRET_NAME_LENGTH + 2;

/**
 * Column headings. STATUS is drawn only when a row has something to put in it: a permanent
 * column of blanks teaches the eye to skip the one place a warning will ever appear.
 */
const LIST_HEADINGS = ["PLACEHOLDER", "SCOPE", "EXPIRES", "STATUS"] as const;

/** The remedy, printed under the table when a row is near expiry, so the warning is actionable. */
const LIST_EXPIRY_FOOTER = "Extend one before it lapses: /secret extend <name> 7d.";

/** Two words per urgency level: short enough for a table cell, unlike the sentences `expiryWarnings` writes. */
const LIST_STATUS_LABEL: Record<ExpiryUrgency, string> = { soon: "expires soon", halfway: "past halfway" };

/** Shared by both empty-vault variants, so only the entry forms differ between surfaces. */
const EMPTY_VAULT_PREAMBLE = [
	"No active secrets. Nothing is being substituted right now.",
	"",
	"Store one and the agent can spend it by writing #NAME#, never seeing the value itself:",
];
const EMPTY_VAULT_HELP = [
	...EMPTY_VAULT_PREAMBLE,
	`${OUTPUT_INDENT}${USAGE_TUI_MASKED}`,
	`${OUTPUT_INDENT}${USAGE_TUI_INLINE}`,
	`${OUTPUT_INDENT}${USAGE_TUI_FROM_ENV}`,
].join("\n");
const NONINTERACTIVE_EMPTY_VAULT_HELP = [...EMPTY_VAULT_PREAMBLE, `${OUTPUT_INDENT}${USAGE_ADD_FROM_ENV}`].join("\n");

async function listSecrets(context: {
	vault: SecretVault;
	now: number;
	surface?: SecretCommandSurface;
}): Promise<SecretCommandResult> {
	// The list must survive a vault it cannot read, because it is where an operator goes to find out
	// what is wrong. Throwing here made `-p /secret list` exit non-zero with nothing on stdout while
	// stderr recommended a command the same throw prevented from running.
	let entries: readonly ScopedVaultEntry[] = [];
	let everywhere: readonly ScopedVaultEntry[] = [];
	let unreadable: readonly VaultScope[] = [];
	try {
		entries = await context.vault.load();
		// The every-scope view, for the shadow note only. `load` collapses a repeated name to its
		// narrowest holder, so the copies that are stored and NOT spendable are exactly the ones it
		// drops, and a list built from it alone cannot mention them.
		everywhere = await context.vault.loadEverywhere();
		// A partially readable vault: `load` skipped a scope and kept going.
		unreadable = context.vault.unreadableScopes();
	} catch (error) {
		unreadable = await context.vault.noteFailedLoad(error);
	}
	return {
		message: renderSecretList(entries, {
			now: context.now,
			surface: context.surface,
			unreadable,
			everywhere,
		}),
		changed: false,
	};
}

/**
 * Render `/secret list` for a person.
 *
 * Exported and separated from the vault read for the reason {@link renderLog} is: the layout is
 * the part worth asserting byte for byte, and here it can be asserted without a filesystem, a
 * vault key or a live session.
 *
 * A TABLE, NOT THREE SPACE-JOINED FIELDS. The previous form printed `  #NAME#  scope  time-left`
 * per row with no header, so the moment two names differed in length the scopes and lifetimes
 * stopped lining up and every row had to be read from its start to find the column you wanted.
 * Column widths come from `visibleWidth`, the TUI's `Bun.stringWidth` wrapper, never `.length`:
 * as far as this function is concerned a name is arbitrary text, and one wide-character grapheme
 * occupies two terminal columns while counting as one unit of `.length` — a table that looks
 * aligned only in an ASCII fixture.
 *
 * NO VALUE APPEARS, not even a prefix. A prefix of a credential is still a disclosure, and
 * showing one invites a screenshot that leaks it. `load` returns the effective entry for each
 * name, so "active" is exact even when a wider-scope copy is shadowed by project/profile
 * precedence.
 */
export function renderSecretList(
	entries: readonly ScopedVaultEntry[],
	options: {
		now: number;
		surface?: SecretCommandSurface;
		unreadable?: readonly VaultScope[];
		everywhere?: readonly ScopedVaultEntry[];
	},
): string {
	const surface = options.surface ?? "tui";
	const broken = describeUnreadableScopes(options.unreadable ?? []);
	const shadowed = describeShadowedCopies(entries, options.everywhere ?? entries);
	// "No active secrets" is FALSE when a vault exists and could not be read, and it is the specific
	// falsehood this whole area exists to avoid: it reads as "you have nothing stored" to someone
	// whose credentials are sitting in a file three lines away. Absent and unreadable are different
	// answers to "what do I have", so they get different output.
	if (entries.length === 0) {
		if (broken !== undefined) return broken;
		return surface === "tui" ? EMPTY_VAULT_HELP : NONINTERACTIVE_EMPTY_VAULT_HELP;
	}

	const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
	const rows = sorted.map(entry => {
		const urgency = expiryUrgency(entry, options.now);
		return [
			`#${entry.name}#`,
			entry.scope,
			describeTimeLeft(entry, options.now),
			urgency === null ? "" : LIST_STATUS_LABEL[urgency],
		];
	});
	const nearExpiry = rows.some(row => row[3] !== "");
	const columns = nearExpiry ? LIST_HEADINGS.length : LIST_HEADINGS.length - 1;
	// A name arrives from a file, which makes it operator-supplied text rather than something this
	// module produced. A tab or a newline would break the table apart and an over-long name would
	// push the later columns out of view, so both are handled rather than trusted not to happen.
	const cells = [LIST_HEADINGS, ...rows].map(row =>
		row
			.slice(0, columns)
			.map(cell => truncateToWidth(sanitizeSingleLine(cell), MAX_LIST_CELL_WIDTH, Ellipsis.Unicode)),
	);
	const widths = cells[0].map((_, column) => Math.max(...cells.map(row => visibleWidth(row[column]))));

	const lines = [
		`${formatCount("active secret", sorted.length)}. The agent spends one by writing its placeholder; the value is never shown.`,
		...cells.map(row => renderListRow(row, widths)),
	];
	if (nearExpiry) lines.push(LIST_EXPIRY_FOOTER);
	// Before the broken-scope caveat, because a shadowed copy is a fact about the vault you HAVE and
	// the caveat is about the part that could not be read at all.
	if (shadowed !== undefined) lines.push(shadowed);
	// LAST, and only when a scope is broken. The table above is the answer to the question; this is
	// the caveat that some of the answer is missing, and a caveat above the table reads as an error.
	if (broken !== undefined) lines.push(broken);
	return lines.join("\n");
}

/**
 * Say which stored copies are held under a name that resolves to a different one.
 *
 * WHY THE LIST HAS TO MENTION THEM. The table is one row per name, because one row per name is what
 * the agent can spend: a name held in two scopes resolves to the narrowest and the other copy is
 * inert. Inert is not gone. The credential is still on disk, still decryptable, and becomes live
 * the moment the copy in front of it is removed, which is a thing an operator does while believing
 * they are revoking that name. Before this, the only way to discover the second copy was to remove
 * the first and read the sentence that removal now prints, which is late: it announces a credential
 * you did not know you had, at the moment it starts being spent.
 *
 * The note names the scope rather than counting, since "1 shadowed copy" tells you to go looking
 * and the scope tells you where. It stays out of the table on purpose. Giving a shadowed copy its
 * own row would put something in the spendable list that cannot be spent, which is the confusion
 * this note exists to remove.
 */
function describeShadowedCopies(
	entries: readonly ScopedVaultEntry[],
	everywhere: readonly ScopedVaultEntry[],
): string | undefined {
	const effective = new Map(entries.map(entry => [entry.name, entry.scope]));
	const hidden = everywhere.filter(entry => {
		const winner = effective.get(entry.name);
		return winner !== undefined && winner !== entry.scope;
	});
	if (hidden.length === 0) return undefined;
	// Broken across two indented lines, the way `describeUnreadableScopes` below does it. As one
	// sentence this ran past 150 columns and the terminal hard-wrapped it mid-word, against a
	// neighbouring footer that wraps by hand: the two footers of the same table would have disagreed
	// about whether the list controls its own line breaks.
	return hidden
		.flatMap(entry => {
			const winner = effective.get(entry.name);
			return [
				`${OUTPUT_INDENT}#${entry.name}# is also stored in the ${entry.scope} vault, shadowed by the ${winner} one.`,
				`${OUTPUT_INDENT}Only the ${winner} copy is spent. Remove it with /secret rm ${entry.name} ${entry.scope}.`,
			];
		})
		.join("\n");
}

/**
 * Say which scopes could not be read, and how to repair them.
 *
 * `/secret list` used to say nothing at all about a skipped scope, so a vault with a broken project
 * file and a healthy profile one printed a confident table of the profile entries and left the
 * operator to discover the rest were missing when a placeholder refused to spend. The list is where
 * someone goes to find out what they have; it is the wrong place to be silent about what it cannot
 * see. Worded to match `noteFailedVaultLoad` in vault.ts, because an operator hits both within a
 * minute and two descriptions of one repair reads as two problems.
 */
function describeUnreadableScopes(unreadable: readonly VaultScope[]): string | undefined {
	if (unreadable.length === 0) return undefined;
	const many = unreadable.length > 1;
	const scopes = unreadable.join(" and ");
	const commands = unreadable.map(scope => `/secret discard ${scope}`).join(" and ");
	return (
		`${OUTPUT_INDENT}Your ${scopes} ${many ? "vaults" : "vault"} could not be read, so anything stored in ` +
		`${many ? "them is" : "it is"} missing from this list and cannot be spent.\n${OUTPUT_INDENT}` +
		`${many ? "They are" : "It is"} encrypted, so a hand edit cannot repair ${many ? "them" : "it"}. ` +
		`Run ${commands} to move the unreadable ${many ? "files" : "file"} aside, then re-add the secrets ` +
		`${many ? "they" : "it"} held.`
	);
}

/** One table row: every cell but the last padded to its column, and no trailing blanks. */
function renderListRow(row: readonly string[], widths: readonly number[]): string {
	let line = OUTPUT_INDENT;
	for (const [column, cell] of row.entries()) {
		// The last column is never padded, so an empty STATUS cell cannot leave a run of spaces
		// in a line the operator is likely to copy straight out of the terminal.
		line += column === row.length - 1 ? cell : cell + padding(widths[column] - visibleWidth(cell) + LIST_GUTTER);
	}
	return line.trimEnd();
}

async function removeSecret(
	request: SecretCommandRequest,
	context: { vault: SecretVault },
): Promise<SecretCommandResult> {
	if (request.name === undefined) throw new Error("Which secret? /secret rm <name>");

	const name = normaliseSecretName(request.name);
	// What the placeholder spends BEFORE the removal. Needed because a removal has three different
	// outcomes and only one of them is a revocation, and they cannot be told apart afterwards.
	const spentBefore = (await context.vault.load()).find(entry => entry.name === name);
	const scope = await context.vault.remove(request.name, request.scope);
	if (scope === null) {
		// Naming the scope that was searched matters when one was asked for. "No secret named X is
		// stored" is untrue if X is sitting in another vault, and it reads as "it is already gone",
		// which is the one conclusion that stops the operator looking for the copy still in effect.
		const where = request.scope === undefined ? "is stored" : `is stored in the ${request.scope} vault`;
		throw new Error(`No secret named ${name} ${where}. Run /secret list to see what is.`);
	}
	// Scopes shadow each other, so removing one copy of a name does not always end the placeholder.
	// Three outcomes, and reporting the wrong one is not a wording problem:
	//
	//   1. Nothing is left. A real revocation, and the model has to be told to stop writing `#NAME#`.
	//   2. The copy in effect was removed and another was underneath it. `#NAME#` still expands, to
	//      a DIFFERENT credential. Calling that a revocation is false in the direction that costs
	//      most: the operator believes the credential is gone while the placeholder goes on spending
	//      one, and the next use authenticates as a different identity with nothing saying so.
	//   3. A shadowed copy was removed. What `#NAME#` spends did not change at all, so there is
	//      nothing to tell the model, and a revocation notice would retire a live credential.
	//
	// `list` resolves by precedence and so never showed the second copy, which is what let all of
	// this stay invisible from both sides.
	const spentNow = (await context.vault.load()).find(entry => entry.name === name);
	if (spentNow === undefined) {
		return {
			message: `Removed ${name} from the ${scope} vault.`,
			// Stated outright rather than left as an inference. A name quietly vanishing from the vault
			// is invisible to a model that was introduced to it several turns ago: it keeps writing the
			// placeholder, nothing expands it any more, and the literal text arrives at the command as
			// though it were the credential. The authentication failure that follows explains nothing.
			agentNotice:
				`The user has revoked the secret ${name}, so #${name}# is no longer available and you must ` +
				`stop using it. It is no longer replaced with a real value: writing it now sends the literal ` +
				`text #${name}# rather than a credential, which will fail instead of authenticating. Do not ` +
				`write #${name}# into a command, a file, or a message, and do not ask for the value.`,
			agentNoticeIsRevocation: true,
			changed: true,
		};
	}
	if (spentBefore?.scope === scope) {
		return {
			message:
				`Removed ${name} from the ${scope} vault. A ${spentNow.scope} secret of the same name was ` +
				`underneath it, so #${name}# still spends a credential, now that one. ` +
				`Run /secret rm ${name} ${spentNow.scope} to remove that one too.`,
			// Deliberately NOT a revocation notice. The placeholder still resolves, so telling the
			// model to stop using it would be wrong, and marking it revoked would have the session
			// treat a live credential as dead.
			agentNotice:
				`The secret ${name} now refers to a different stored credential: the ${scope} one was removed ` +
				`and a ${spentNow.scope} one of the same name is now what #${name}# spends. It is still a real ` +
				`credential, so keep writing #${name}# where that credential belongs, and be aware it may ` +
				`authenticate as a different identity than it did earlier in this session.`,
			changed: true,
		};
	}
	// The removed copy was already shadowed, so nothing the model can observe has changed. No
	// notice at all is the honest report: there is no revocation to announce and no new meaning.
	return {
		message:
			`Removed ${name} from the ${scope} vault. It was shadowed by the ${spentNow.scope} secret of the ` +
			`same name, so #${name}# spends what it spent before.`,
		changed: true,
	};
}

/**
 * Empty one scope's vault and say what that did to every placeholder it held.
 *
 * ON `removeSecret`'S TERMS, not a loop over it. A cleared scope can leave a name still spending a
 * credential, because a wider vault may hold a copy the resolved view was hiding, so the same three
 * outcomes apply here and get the same treatment: a name with nothing underneath it is revoked and
 * the model is told to stop writing it; a name with a copy underneath still expands, to a DIFFERENT
 * credential, and calling that revoked would have the session believe a live credential is dead.
 * The difference is only that one command decides it for every name at once.
 *
 * WHY IT NAMES THEM. `list` is the only other place a name appears, and after this command there is
 * nothing left to list; an operator who cleared the wrong scope needs to read what went, and a
 * count cannot answer that. Names are the safe half of an entry -- the placeholder is built from
 * them and the value is never near this string.
 */
async function clearVaultScope(
	request: SecretCommandRequest,
	context: { vault: SecretVault },
): Promise<SecretCommandResult> {
	// The parser refuses a scopeless `clear`, so this is unreachable from a parsed line. It is here
	// because `runSecretCommand` is exported and a caller building a request by hand would otherwise
	// empty whichever vault an `undefined` narrowed to.
	if (request.scope === undefined) {
		throw new Error("Which vault? /secret clear profile");
	}
	const scope = request.scope;
	const removed = [...(await context.vault.clear(scope))].sort();
	if (removed.length === 0) {
		return { message: `The ${scope} vault holds no secrets, so nothing was removed.`, changed: false };
	}
	const live = new Set((await context.vault.load()).map(entry => entry.name));
	const revoked = removed.filter(name => !live.has(name));
	const shadowing = removed.filter(name => live.has(name));
	const count = `${removed.length} ${removed.length === 1 ? "secret" : "secrets"}`;
	const lines = [`Removed ${count} from the ${scope} vault: ${removed.join(", ")}.`];
	if (shadowing.length > 0) {
		lines.push(
			`${shadowing.join(", ")} ${shadowing.length === 1 ? "is" : "are"} also stored in another vault, so ` +
				`${shadowing.length === 1 ? "that placeholder" : "those placeholders"} still spend a credential. ` +
				`Clear that scope too to end ${shadowing.length === 1 ? "it" : "them"}.`,
		);
	}
	if (revoked.length === 0) {
		// Nothing the model can observe changed: every name it knows still resolves, to a credential
		// that is still real. A revocation notice here would retire live credentials.
		return { message: lines.join("\n"), changed: true };
	}
	const names = revoked.map(name => `#${name}#`).join(", ");
	return {
		message: lines.join("\n"),
		agentNotice:
			`The user has cleared the ${scope} secret vault, so ${names} ${revoked.length === 1 ? "is" : "are"} no ` +
			`longer available and you must stop using ${revoked.length === 1 ? "it" : "them"}. ` +
			`${revoked.length === 1 ? "It is" : "They are"} no longer replaced with a real value: writing ` +
			`${revoked.length === 1 ? "it" : "one"} now sends the literal placeholder text rather than a ` +
			`credential, which will fail instead of authenticating. Do not write ${names} into a command, a file, ` +
			`or a message, and do not ask for the value.`,
		agentNoticeIsRevocation: true,
		changed: true,
	};
}

async function extendSecret(
	request: SecretCommandRequest,
	context: { vault: SecretVault; defaultTtl: number | null; now: number },
): Promise<SecretCommandResult> {
	if (request.name === undefined) throw new Error("Which secret? /secret extend <name> 7d");

	const ttl = request.ttl === undefined ? context.defaultTtl : request.ttl;
	const entry = await context.vault.extend(request.name, ttl);
	if (entry === null) {
		throw new Error(
			`No secret named ${normaliseSecretName(request.name)} is stored. Run /secret list to see what is.`,
		);
	}
	return {
		message:
			`${entry.name} in the ${entry.scope} vault now lasts ${formatTtl(ttl)} from now ` +
			`(${describeTimeLeft(entry, context.now)}).`,
		// Reassurance, not instruction: the name did not change, so restating the whole placeholder
		// explainer would be noise. The new duration is deliberately absent, because it would sit in
		// the conversation long after it stopped being true and the operator already has the exact
		// time left on screen.
		agentNotice:
			`The user has refreshed the lifetime of the secret ${entry.name}. #${entry.name}# is still ` +
			`available, so keep referencing that placeholder wherever the credential belongs.`,
		changed: true,
	};
}

/**
 * Read a credential out of the environment, or refuse in terms of the variable that failed.
 *
 * ONE OWNER for the three ways an environment variable can fail to hold a credential, because
 * `from-env` and `value` both read one and a refusal worded differently between them would be two
 * diagnoses of one mistake.
 *
 * Set-but-empty is kept DISTINCT from unset, because collapsing the two told an operator that a
 * variable they had just exported "is not set", sending them to re-check an export that was
 * already there while the real cause was an assignment that set it to nothing. Each case gets the
 * fix that applies to it. Whitespace-only is refused rather than trimmed and stored: nothing made
 * only of spaces is a credential, and storing it would mint a placeholder that spends blank text
 * into a command. A value that merely CONTAINS surrounding space is stored byte for byte, since a
 * real credential is allowed to and trimming one would corrupt it.
 */
function readEnvCredential(variable: string, readEnv: (name: string) => string | undefined): string {
	const value = readEnv(variable);
	if (value === undefined) {
		throw new Error(
			`The environment variable ${variable} is not set in this process, so there is nothing to store. ` +
				`Note that it must be set for the veyyon process, not only in a shell you opened afterwards.`,
		);
	}
	if (value.length === 0) {
		throw new Error(
			`The environment variable ${variable} is set but empty, so there is no credential to store. ` +
				`Check where it is exported: an assignment such as ${variable}= sets it to nothing.`,
		);
	}
	if (value.trim().length === 0) {
		throw new Error(
			`The environment variable ${variable} contains only whitespace, so there is no credential to ` +
				`store. Storing it would create a placeholder that spends blank text.`,
		);
	}
	return value;
}

async function renameSecret(
	request: SecretCommandRequest,
	context: { vault: SecretVault },
): Promise<SecretCommandResult> {
	if (request.name === undefined || request.newName === undefined) {
		throw new Error("Which secret, and to what? /secret rename <name> <new-name>");
	}
	const from = normaliseSecretName(request.name);
	const to = normaliseSecretName(request.newName);
	// Answered rather than refused, and reported as no change. The vault treats this as a read for
	// the same reason: there is nothing wrong with the line, it just asks for the state that holds.
	if (from === to) return { message: `${from} already has that name, so nothing was changed.`, changed: false };
	// A destination that is already taken throws from the vault, which owns that refusal because it
	// owns the scope walk that found the collision.
	const renamed = await context.vault.rename(from, to);
	if (renamed === null) throw new Error(`No secret named ${from} is stored. Run /secret list to see what is.`);
	return {
		message:
			`${from} is now ${renamed.name} in the ${renamed.scope} vault, with the same value and the same ` +
			`lifetime. #${from}# no longer expands.`,
		// BOTH halves in one notice. The model has `#OLD#` in its history and will keep writing it,
		// and the credential it used to spend is still live under the new name, so saying only that
		// the old placeholder is dead would strand a working credential the model can no longer reach.
		agentNotice:
			`The user has renamed the secret ${from} to ${renamed.name}. #${from}# is no longer replaced with ` +
			`a value: writing it now sends the literal text #${from}# rather than a credential. The same ` +
			`credential is available as #${renamed.name}#, so use that placeholder wherever you used the old one.`,
		changed: true,
	};
}

async function replaceSecretValue(
	request: SecretCommandRequest,
	context: {
		vault: SecretVault;
		readEnv: (name: string) => string | undefined;
		now: number;
		surface?: SecretCommandSurface;
	},
): Promise<SecretCommandResult> {
	if (request.name === undefined) throw new Error("Which secret? /secret value <name>");
	if (request.fromEnv !== undefined && request.value !== undefined) {
		throw new Error("Give either an environment variable or a value, not both.");
	}
	const name = normaliseSecretName(request.name);
	let value: string;
	let typedOnScreen = false;
	if (request.fromEnv !== undefined) {
		value = readEnvCredential(request.fromEnv, context.readEnv);
	} else if (request.value !== undefined) {
		value = request.value;
		typedOnScreen = request.maskedEntry !== true;
	} else {
		// Reached only where there is no terminal to mask; an interactive session opens a hidden field
		// instead (see `needsValuePrompt`). The refusal recommends the form the surface can carry out.
		throw new Error(
			`No value given, and this client cannot prompt for one without showing it. ` +
				`Name an environment variable to read it from:\n  /secret value ${name} from-env MY_TOKEN`,
		);
	}
	const entry = await context.vault.replaceValue(name, value);
	if (entry === null) throw new Error(`No secret named ${name} is stored. Run /secret list to see what is.`);
	const lines = [
		// The lifetime is repeated BECAUSE IT DID NOT RESTART, which is the whole difference between
		// this and storing over the name with `add`, and otherwise takes a `/secret list` to confirm.
		`${entry.name} in the ${entry.scope} vault has a new value, ${describeTimeLeft(entry, context.now)}.`,
		`The name and the lifetime are unchanged, so #${entry.name}# now spends what you just gave it.`,
	];
	if (typedOnScreen) lines.push(SCROLLBACK_WARNING);
	return {
		message: lines.join("\n"),
		// NO NOTICE. The placeholder, its name and its meaning are exactly what the model was already
		// told; only the bytes behind it changed, and it never had those.
		changed: true,
	};
}

async function moveSecretScope(
	request: SecretCommandRequest,
	context: { vault: SecretVault; now: number },
): Promise<SecretCommandResult> {
	if (request.name === undefined) throw new Error("Which secret? /secret scope <name> profile|project|global");
	// Established by `refuseMissingScope` before this runs. Restated so the function reads on its own
	// and so a future caller that skips the parser cannot move a secret into an unnamed vault.
	if (request.scope === undefined) throw new Error("Which vault? /secret scope <name> profile|project|global");
	const name = normaliseSecretName(request.name);
	// EVERY scope, not the resolved view. The entry being moved may be shadowed by a copy in a
	// narrower vault, and the destination check has to see occupants a resolved read hides.
	const everywhere = await context.vault.loadEverywhere();
	const entry = everywhere.find(candidate => candidate.name === name);
	if (entry === undefined) throw new Error(`No secret named ${name} is stored. Run /secret list to see what is.`);
	if (entry.expiresAt !== null && entry.expiresAt <= context.now) {
		throw new Error(
			`${name} has expired, so there is nothing to move: it would arrive in the ${request.scope} vault ` +
				`already lapsed. Store it again in that vault instead: /secret from-env MY_TOKEN ${name} ${request.scope}.`,
		);
	}
	const { plan, refusal } = planScopeMove(entry, request.scope, everywhere);
	if (plan === null) throw new Error(refusal ?? `${name} cannot move to the ${request.scope} vault.`);
	// ADD FIRST, REMOVE SECOND, never the other way round. The plan has established the destination
	// is free, so the add cannot overwrite anything, and a crash between the two writes leaves the
	// credential in both vaults, which `/secret list` reports and the operator can finish by hand.
	// Removing first and then failing to add would destroy the credential outright.
	//
	// The deadline is carried across as the time REMAINING, so a move does not lengthen a lifetime:
	// `add` dates an entry from now, and passing the original window would hand back time already
	// spent. A secret that never expires keeps that.
	const ttl = entry.expiresAt === null ? null : entry.expiresAt - context.now;
	const moved = await context.vault.add({ name: entry.name, value: entry.value, scope: plan.to, ttl });
	await context.vault.remove(entry.name, plan.from);
	return {
		message:
			`Moved #${moved.name}# from the ${plan.from} vault to the ${plan.to} vault, ` +
			`${describeTimeLeft(moved, context.now)}. The value and the deadline are unchanged.`,
		// No notice: the placeholder and what it spends are both exactly as they were. Which file the
		// credential lives in is the operator's business and not the model's.
		changed: true,
	};
}

async function copyPlaceholder(
	request: SecretCommandRequest,
	context: { vault: SecretVault },
): Promise<SecretCommandResult> {
	if (request.name === undefined) throw new Error("Which secret? /secret copy <name>");
	const name = normaliseSecretName(request.name);
	// The resolved view, deliberately: the placeholder means whichever copy is in effect, so a name
	// held in two vaults copies one token either way and the scope reported is the one it spends.
	const entry = (await context.vault.load()).find(candidate => candidate.name === name);
	if (entry === undefined) throw new Error(`No secret named ${name} is stored. Run /secret list to see what is.`);
	return {
		// THE PLACEHOLDER, NOT THE VALUE, and the message says so outright rather than leaving the
		// operator to guess what landed on the clipboard. A surface with no clipboard still gets the
		// token in the message, which is the answer to "what do I write to spend this".
		message: `#${entry.name}# is the placeholder for the ${entry.scope} secret. The value is never copied.`,
		copyText: `#${entry.name}#`,
		changed: false,
	};
}

async function showLog(
	request: SecretCommandRequest,
	context: { auditLog?: SecretAuditLog; now: number },
): Promise<SecretCommandResult> {
	if (context.auditLog === undefined) {
		return {
			message:
				`Secret use is not being recorded, so there is no log to show. ` +
				`Turn on "Record Secret Use" in /settings (secrets.auditLog) to start recording.`,
			changed: false,
		};
	}

	const limit = request.limit ?? DEFAULT_LOG_LIMIT;
	const wanted = request.name;
	// READ EVERYTHING, THEN NARROW, THEN LIMIT. `read({ limit })` keeps the last N records of the
	// whole log, so limiting first and filtering second would answer "the last 20 uses, of which 3
	// were this secret" to a question that asked for the last 20 uses OF this secret. The read is
	// already bounded by the log's own rotation and decode ceilings, so the wider read costs nothing
	// a bare limit of 20 did not already cost.
	const { records, malformed } = await context.auditLog.read(wanted === undefined ? { limit } : undefined);
	const shown =
		wanted === undefined ? records : records.filter(record => record.secrets.includes(`#${wanted}#`)).slice(-limit);
	const rendered = renderLog(shown, { malformed, path: context.auditLog.path, now: context.now });
	if (wanted === undefined) return { message: rendered, changed: false };
	// Named even when there is nothing to show, because an empty log for one secret and an empty log
	// altogether support opposite conclusions: the first says the credential has not been spent, the
	// second says nothing has.
	return { message: `Uses of #${wanted}#:\n${rendered}`, changed: false };
}

/**
 * Render the expansion log for a person.
 *
 * Separate from reading it so the layout is asserted against exact strings without a filesystem,
 * and so the "nothing recorded yet" case is a readable sentence rather than an empty block that
 * looks like a failure.
 */
export function renderLog(
	records: readonly SecretExpansionRecord[],
	options: { malformed: number; path: string; now: number },
): string {
	const lines: string[] = [];
	if (records.length === 0) {
		lines.push(`No secret has been used yet. The log is ${options.path}.`);
	} else {
		lines.push(`${records.length} most recent use(s), oldest first:`);
		for (const record of records) {
			const ago = describeAgo(options.now - record.at);
			const omitted = record.omittedSecrets === undefined ? "" : ` +${record.omittedSecrets} omitted`;
			lines.push(`  ${ago}  ${record.tool}  ${record.secrets.join(" ")}${omitted}`);
			lines.push(`    ${record.command}`);
		}
	}
	const sessions = new Set(records.map(record => record.session).filter(session => session !== undefined));
	if (sessions.size > 1) {
		// The log belongs to a PROFILE, not a session, so several veyyon processes append to one
		// file. Without this line the rows read as one session's history and an operator counts uses
		// that another window made. The `session` field was recorded and never surfaced anywhere,
		// which is the same as not having it.
		lines.push(`These records come from ${sessions.size} sessions sharing this profile's log.`);
	}
	if (options.malformed > 0) {
		// Said out loud rather than skipped, because a log that quietly drops lines it cannot
		// read is not evidence of anything.
		lines.push(`${options.malformed} line(s) in ${options.path} could not be read and are not shown above.`);
	}
	return lines.join("\n");
}

/**
 * "3m ago", for log rows. Coarse on purpose: the exact millisecond is in the file.
 *
 * Exported so every surface that phrases an instant over this file phrases it the same way. Two
 * spellings of "how long ago" over one log is how two readers of it come to disagree.
 */
export function describeAgo(elapsedMs: number): string {
	if (elapsedMs < 60_000) return "just now";
	const minutes = Math.round(elapsedMs / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(elapsedMs / 3_600_000);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(elapsedMs / 86_400_000)}d ago`;
}

/**
 * Read the configured default lifetime, refusing a setting that does not parse.
 *
 * Refuses rather than falling back to {@link DEFAULT_TTL_MS}, because a typo in the setting
 * would otherwise grant every secret a different lifetime than the operator wrote, silently.
 */
export function resolveDefaultTtl(setting: string | undefined): number | null {
	// An absent setting is not a misconfiguration: it means nothing has been written, so the
	// built-in default applies. `secrets.defaultTtl`'s declared default and DEFAULT_TTL_MS are
	// pinned to each other by a test rather than by one importing the other.
	if (setting === undefined || setting.trim().length === 0) return DEFAULT_TTL_MS;
	try {
		return parseTtl(setting);
	} catch (error) {
		throw new Error(
			`The secrets.defaultTtl setting is "${setting}", which is not a lifetime ` +
				`(${errorMessage(error)}). ` +
				`Fix it in /settings. Until then no default can be applied.`,
		);
	}
}

/** How close an entry is to lapsing. */
type ExpiryUrgency = "soon" | "halfway";

/**
 * Classify an entry against the warning thresholds. ONE owner, read by everything that has to
 * say "this one is nearly gone".
 *
 * THROUGH `warningThresholdCrossed`, NOT ITS OWN ARITHMETIC. {@link expiryWarnings} used to
 * compare against an inline `0.9` while `WARN_AT_FRACTIONS` said `[0.5, 0.9]`, so there were two
 * owners of "when do we warn" and they disagreed: the halfway warning the setting promised was
 * never raised by anything. The STATUS column in {@link renderSecretList} would have been the
 * third owner, which is why the classification lives here and not at either call site.
 *
 * The LAST fraction in the list is the urgent one, read from the list rather than written here
 * as a literal. That inline `0.9` was the original bug, and repeating it one level down would
 * have re-created it: adding a 0.99 threshold would then have described a secret with minutes
 * left as merely over halfway through its lifetime.
 */
function expiryUrgency(entry: ScopedVaultEntry, now: number): ExpiryUrgency | null {
	const crossed = warningThresholdCrossed(entry, now);
	if (crossed === null) return null;
	return crossed >= WARN_AT_FRACTIONS[WARN_AT_FRACTIONS.length - 1] ? "soon" : "halfway";
}

/**
 * Warnings for secrets far enough through their lifetime to be worth mentioning.
 *
 * A sentence per entry, where `/secret list` shows the same classification as a two-word column.
 * Both read {@link expiryUrgency}, so a threshold added to `WARN_AT_FRACTIONS` takes effect in
 * both without a second edit, and neither can call a secret nearly expired while the other
 * calls it healthy.
 *
 * Each line names the remedy, because a warning you cannot act on is noise. Expiry deletes the
 * value, so the action is to extend it before that happens rather than after. The remedy is a
 * command, not a keystroke on a screen: `extend` is a reserved word in a terminal too, so the
 * line this prints is runnable wherever it is read.
 */
export function expiryWarnings(entries: readonly ScopedVaultEntry[], now: number): string[] {
	const warnings: string[] = [];
	for (const entry of entries) {
		const urgency = expiryUrgency(entry, now);
		if (urgency === null) continue;
		const phrase = urgency === "soon" ? "expires soon" : "is over halfway through its lifetime";
		warnings.push(
			`#${entry.name}# ${phrase}, ${describeTimeLeft(entry, now)}. ` +
				`Extend it with /secret extend ${entry.name} 7d, or it will be deleted.`,
		);
	}
	return warnings;
}
