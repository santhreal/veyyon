/**
 * What `/secret` does, as pure logic over a vault.
 *
 * SEPARATE FROM THE REGISTRY ON PURPOSE. Domain logic does not import the CLI or the TUI, so
 * every rule below is testable without constructing a session, and the registry handler is a
 * thin adapter that parses a line and prints a string. The alternative, putting this inside
 * the 2000-line builtin registry, would make the security-relevant behaviour reachable only
 * through a live TUI.
 *
 * ONE GRAMMAR, TWO ENTRY FORMS. Every subcommand parses on every surface: `add`, `list`, `rm`,
 * `rename`, `value`, `scope`, `copy`, `extend`, `log`, `discard` and `help`. What the
 * surfaces disagree about is how a credential is entered, because that is a security property and
 * not a matter of taste. In a terminal the first word decides: a reserved word is a command, and
 * anything else is the credential itself, so stashing a token costs one paste and no verb, while
 * `add` stores a value that happens to begin with a reserved word. A client with no masked field
 * cannot accept a bare value at all, and reaches one only through `--from-env`.
 *
 * WHY THE TERMINAL FORM DROPPED THE NAME. `/secret add <name> <value>` demanded a label before it
 * would accept the thing being labelled, and the two positionals had no unique reading once the
 * value was arbitrary text. Worse, the name came FIRST, so `/secret add ghp_realToken` stored a
 * live credential as a NAME with no value attached. In a terminal `add` is now a synonym for the
 * bare form: it takes no name, the value is the rest of the line, and the name is asked afterwards,
 * optional, with a generated one waiting if the operator declines.
 *
 * WHERE THE VALUE COMES FROM, in order of how much it leaks:
 *   - `--from-env VAR` reads it out of the environment. The credential is never typed, so it
 *     never enters the input buffer or the scrollback. This is the recommended form and the
 *     only one that works in a non-interactive client.
 *   - a masked field, reached by a bare `/secret`, keeps it out of the scrollback but not out
 *     of the input buffer.
 *   - an inline value is accepted, because the whole point is that stashing a token costs one
 *     paste. It is visible on screen until the editor is cleared, so {@link addSecret} says so
 *     in its confirmation rather than leaving the user to assume otherwise.
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
 * The TUI forms describe a grammar where the value needs no verb: `/secret <anything>` IS the
 * credential, so stashing one costs a paste. The verbs are spelled out below it because they work
 * in the terminal too, and an operator told that `list` exists has to be able to type it. The
 * noninteractive forms drop the bare value, because that surface has no way to hide what is typed.
 */
const USAGE_TUI_INLINE = "/secret <value>                       store it now, then name it (optional)";
const USAGE_TUI_MASKED = "/secret                               paste into a hidden field instead";
const USAGE_TUI_FROM_ENV = "/secret --from-env <VAR>              store the value of an environment variable";
/**
 * The escape for the one input the reserved words cost: a credential whose first word is one.
 *
 * SPELLED AS THE VERB, not as `--`. A slash command is not a shell command line, and nobody types
 * `--` into one: the convention it borrowed from means "options are over" to a shell, and here
 * there were never options to end. `/secret add <value>` already stored such a line verbatim --
 * `add` hands the rest of the line to the same value reader the bare form uses, reserved first word
 * and all -- so `--` was a second spelling of a thing the obvious verb did, and the one that had to
 * be taught. The escape now costs a word the operator would have guessed.
 *
 * Listed with the entry forms rather than dropped in a footnote, because the operator who needs it
 * is mid-refusal and the refusal points here.
 */
const USAGE_TUI_ESCAPE = "/secret add <value>                   store a value starting with a word below";
const USAGE_ADD_FROM_ENV = "/secret add <name> --from-env <VAR>   store the value of an environment variable";

/**
 * What each subcommand actually reads: its options, and how many bare words it takes.
 *
 * The ONE owner of that mapping, declared as data rather than checked with a chain of `if`s, so
 * parsing, error messages and guards cannot describe different sets of rules. `add` has unbounded
 * words because its second positional is the untouched credential suffix, not a word list.
 *
 * EXPORTED so the grammar suites can be derived from it rather than restating it. A hand-written
 * copy of this table in a test goes stale the moment a verb is added, and a stale copy is the same
 * thing as no test: the new verb's options and word count are then asserted by nobody.
 *
 * `needsScope` is REQUIRED on every entry, and it is data rather than prose for the same reason.
 * Three verbs refuse a request with no scope instead of defaulting one, that fact was stated only
 * in a comment and in a chain of `if`s inside the guard, and every suite that builds a well-formed
 * line therefore had to hardcode which verbs those were. A required field means a new verb cannot
 * be added without answering the question, and the guard and the suites read the same answer.
 */
export const SECRET_SUBCOMMAND_SHAPES: Record<
	SecretSubcommand,
	{ options: readonly string[]; words: number; needsScope: boolean }
> = {
	add: { options: ["--from-env", "--ttl", "--scope"], words: Number.POSITIVE_INFINITY, needsScope: false },
	list: { options: [], words: 0, needsScope: false },
	// OPTIONAL scope, unlike `discard`. Omitted, removal takes the narrowest match, which is the
	// entry currently in effect and so the one the operator means almost every time. Named, it
	// removes from that scope only. Without the option a name held in two scopes had its outer
	// copy stranded: every `rm` took the inner one, and there was no way to reach the other.
	rm: { options: ["--scope"], words: 1, needsScope: false },
	// REQUIRED scope, on `discard`'s terms and for a sharper reason: this one empties a vault that
	// reads perfectly well. There is no narrowest-wins default to fall back on, because "the vault"
	// is three files and the operator can only mean one of them, and a bare word after `clear` would
	// read as a secret name -- which is `rm`, a different and much smaller command.
	clear: { options: ["--scope"], words: 0, needsScope: true },
	// TWO words: the name, then the new name. The second one is a name and not a credential, so it
	// is read off the line where `add`'s never is, and a third word is still refused.
	rename: { options: [], words: 2, needsScope: false },
	// ONE word, and the replacement arrives the way a credential always does: from a masked field,
	// or from the environment. Reading it off the line is allowed for the same reason `add` allows
	// it and no more, and it costs the same scrollback warning.
	value: { options: ["--from-env"], words: 1, needsScope: false },
	// TWO words: the name, then the destination vault. The destination is a positional rather than
	// `--scope`, because on this verb it is the entire point of the line and not an option to it --
	// which is why this one needs a scope while taking no `--scope` option.
	scope: { options: [], words: 2, needsScope: true },
	copy: { options: [], words: 1, needsScope: false },
	extend: { options: ["--ttl"], words: 1, needsScope: false },
	// `--name` narrows the log to one secret. Without it the log is every use, which is the right
	// default for "what has been spent" and the wrong one for "who has been spending this".
	log: { options: ["--limit", "--name"], words: 0, needsScope: false },
	// REQUIRED scope, so `words: 0` and the guard below. The scope names a FILE to move aside
	// rather than a place to store something, so there is no safe default to fall back on, and a
	// bare word here would read as a secret name, which is the mistake worth refusing outright.
	discard: { options: ["--scope"], words: 0, needsScope: true },
	help: { options: [], words: 0, needsScope: false },
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
	"/secret rm <name> [--scope global]    remove a secret",
	"/secret clear --scope profile         remove every secret in one vault",
	"/secret rename <name> <new-name>      give a secret a different name",
	"/secret value <name>                  replace a secret's value, keeping its name and lifetime",
	"/secret scope <name> global           move a secret to another vault",
	"/secret copy <name>                   copy #NAME#, the placeholder, never the value",
	"/secret extend <name> --ttl 7d        give a secret a fresh lifetime",
	"/secret log [--name X] [--limit 50]   show which secrets were used, and where",
	"/secret discard --scope project       move a broken vault file aside",
];

/**
 * The options, and which subcommands read them.
 *
 * Named per option rather than claimed for all of them. A block that opens with "Options:" and
 * nothing else reads as "every subcommand takes these": they do not. `list` takes none, `rm` takes
 * only `--scope`, `extend` takes only `--ttl`, and `log` is the only reader of `--name`. Advertising
 * a flag the parser then refuses is worse than not mentioning it, because the refusal looks like a
 * bug.
 *
 * ONE FOOTER FOR BOTH SURFACES, because the verbs it annotates parse on both. The surfaces differ
 * in how a VALUE is entered, which is why the entry lines above it differ, and in nothing else; a
 * per-surface footer would be two answers to the question of what `--scope` applies to.
 */
const USAGE_FOOTER_SCOPES =
	"Lifetimes default to the secrets.defaultTtl setting. Scope defaults to profile; project overrides profile, which overrides global.";

/**
 * The annotation column is padded to a fixed width so the option and its verbs line up. Built
 * rather than written out, because the verb half is derived: `--scope` gained a fourth reader and
 * the hand-written sentence went stale in the same commit that added it.
 */
const footerOption = (flag: string, tail: string): string => `${flag.padEnd(37)}${tail}`;

const USAGE_FOOTER = [
	footerOption("--ttl 30m|12h|7d|2w|never", `on ${joinWithAnd(subcommandsTaking("--ttl"))}`),
	footerOption("--scope profile|project|global", `on ${joinWithAnd(subcommandsTaking("--scope"))}`),
	footerOption("--name <name>", `on ${joinWithAnd(subcommandsTaking("--name"))}, to show only that secret's uses`),
	USAGE_FOOTER_SCOPES,
	"Removal without --scope takes the narrowest match, which is the one currently in effect.",
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
	"The value was typed on screen, so it is in your scrollback. Use --from-env next time to avoid that.";

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

/** TUI help leads with the verbless value forms, then every verb the terminal also parses. */
export const SECRET_COMMAND_USAGE = buildUsage(
	[USAGE_TUI_INLINE, USAGE_TUI_MASKED, USAGE_TUI_FROM_ENV, USAGE_TUI_ESCAPE],
	USAGE_MANAGE,
	USAGE_FOOTER,
);

/** Noninteractive help exposes only environment-backed creation and the text management verbs. */
export const NONINTERACTIVE_SECRET_COMMAND_USAGE = buildUsage([USAGE_ADD_FROM_ENV], USAGE_MANAGE, USAGE_FOOTER);

/** Select help that matches what the invoking surface can enter safely. */
export function secretCommandUsage(surface: SecretCommandSurface): string {
	return surface === "tui" ? SECRET_COMMAND_USAGE : NONINTERACTIVE_SECRET_COMMAND_USAGE;
}

/** Every known option, derived from its subcommand owners so the two cannot drift. */
const SECRET_COMMAND_OPTIONS: Record<string, true> = Object.fromEntries(
	Object.values(SECRET_SUBCOMMAND_SHAPES).flatMap(shape => shape.options.map(option => [option, true] as const)),
);

/**
 * The words `/secret` reserves, and which subcommand each one names.
 *
 * ONE OWNER for every spelling, so the parser, the help text and the completion menu cannot
 * disagree about what is a command and what is a credential. The menu derives its entries from
 * this map rather than listing them again, which is what makes a new subcommand offerable the
 * moment it is parseable.
 *
 * WHY RESERVING WORDS IS SAFE. A stored value is arbitrary bytes chosen by an issuer, so nobody's
 * API token is the literal word `list`, and the collision has two escapes: the masked field
 * reached by a bare `/secret` accepts any text at all, and `/secret add` stores the rest of the line
 * verbatim. Reserving EVERY verb is what makes that trade safe: a grammar that reserved only some
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
	list: "list",
	rm: "rm",
	remove: "rm",
	delete: "rm",
	// EVERY WORD AN OPERATOR REACHES FOR TO EMPTY THE VAULT, reserved together. Before `clear`
	// existed, none of these was a verb, so the grammar's fallback stored each one AS A CREDENTIAL:
	// `/secret clear` filed the six-character string "clear" under a generated name, `/secret clear
	// --all` filed the literal "clear --all", and because the first successful `add` also turns
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
	list: { usage: "", description: "Show active secrets, never their values" },
	rm: { usage: "<name> [--scope global]", description: "Remove a stored secret" },
	clear: { usage: "--scope profile", description: "Remove every secret in one vault, naming what it removed" },
	rename: { usage: "<name> <new-name>", description: "Give a stored secret a different name" },
	value: { usage: "<name>", description: "Replace a secret's value, keeping its name and lifetime" },
	scope: { usage: "<name> global", description: "Move a secret to the profile, project or global vault" },
	copy: { usage: "<name>", description: "Copy #NAME#, the placeholder, never the value" },
	extend: { usage: "<name> --ttl 7d", description: "Give a stored secret a fresh lifetime" },
	log: { usage: "[--name X] [--limit 50]", description: "Show which secrets were used, and where" },
	discard: { usage: "--scope project", description: "Move a broken vault file aside" },
	help: { usage: "", description: "Show every form /secret understands" },
};

/**
 * The terminal completion menu: canonical spellings only, in the order above.
 *
 * Aliases are parsed and not offered. `remove`, `delete`, `renew`, `name`, `replace`, `move` and
 * `audit` exist so muscle memory lands somewhere, and listing them beside their canonical twins
 * would double a menu whose whole job is to say what the verbs are.
 */
export const SECRET_TUI_SUBCOMMANDS: readonly { name: SecretSubcommand; usage: string; description: string }[] =
	Object.entries(SECRET_VERB_SPELLINGS)
		.filter(([word, subcommand]) => word === subcommand)
		// The VALUE is used as the name, not the key: the filter above has just established they are
		// the same string, and the value carries the `SecretSubcommand` type a caller needs in order to
		// push a menu entry back through the parser without a cast.
		.map(([, subcommand]) => ({ name: subcommand, ...SECRET_TUI_SUBCOMMAND_HELP[subcommand] }));

/**
 * The shell habit this grammar refuses rather than honours.
 *
 * `--` used to mean "the rest of the line is the credential". It was removed because a slash
 * command has no options to end, so the word taught a shell convention to reach a place the verb
 * `add` already reached.
 *
 * IT IS REFUSED, NOT STORED. Dropping the branch alone would have made the value reader below take
 * `-- sk-live-x` byte for byte, because a bare `--` is not a reserved word: the vault would hold a
 * credential with `-- ` welded to the front, `#NAME#` would expand to it, and the failure would
 * surface much later as an authentication error nobody could trace back to a slash command. A
 * credential is exactly the input whose corruption is invisible until it is spent, so the one
 * spelling that used to mean something else fails closed and names what to type instead.
 *
 * ONLY THE EXACT TOKEN. A value that merely begins with dashes -- `--abc` -- is unreserved and is
 * still stored verbatim, as it was before.
 */
const REMOVED_VALUE_ESCAPE = "--";

/** One whitespace-delimited word of an argument line, with the offsets its slice needs. */
interface SecretToken {
	value: string;
	start: number;
	end: number;
}

/**
 * Read a terminal line as a credential, which is what `/secret` does with anything unreserved.
 *
 * Shared by the bare form and by `/secret add`, so the verb is a synonym rather than a second
 * grammar: whatever `/secret <value>` does, `/secret add <value>` does identically.
 */
function parseTuiValue(args: string, tokens: readonly SecretToken[]): SecretCommandRequest {
	if (tokens.length === 0) return { subcommand: "add" };

	// `--from-env` stays reachable, and only in this exact leading position. It is the one entry
	// form that never puts the credential on screen, so dropping it from the TUI would leave the
	// safest path available to ACP clients and not to the operator sitting at the terminal. The
	// leading position is what keeps it unambiguous: a credential whose first word is literally
	// `--from-env` is not a thing an issuer mints, while a `--from-env` appearing LATER is far
	// more likely to be part of a pasted command line than a flag, and is stored verbatim.
	if (tokens[0].value === "--from-env") {
		const variable = tokens[1]?.value;
		if (tokens.length !== 2 || variable === undefined || variable.startsWith("--")) {
			throw new Error("--from-env needs the name of an environment variable, and nothing else.");
		}
		return { subcommand: "add", fromEnv: variable };
	}

	if (tokens[0].value === REMOVED_VALUE_ESCAPE) {
		throw new Error(
			`${REMOVED_VALUE_ESCAPE} is not part of /secret, and the rest of the line was not stored in case ` +
				`the dashes were meant to be dropped from it. The line after /secret is already the credential, ` +
				`so nothing needs to end the options: write /secret add <value> for a value whose first word is ` +
				`a reserved word, or /secret on its own to paste into a hidden field.`,
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

	// THE FIRST WORD DECIDES. A reserved word is a command, anything else is the credential, so
	// stashing one still costs one paste and no verb. `--from-env` belongs to the value grammar,
	// which both a bare line and `/secret add` reach through the same function.
	if (surface === "tui") {
		const reserved = tokens.length > 0 ? SECRET_VERB_SPELLINGS[tokens[0].value.toLowerCase()] : undefined;
		if (reserved === undefined) return parseTuiValue(args, tokens);
		// `add` is a synonym for the bare form, NOT the noninteractive `add <name> <value>`. The
		// terminal never takes a name inline: the name is asked afterwards, and a name parsed off
		// this line would be a credential written to the vault's plaintext metadata and echoed back
		// on screen, which is the mistake the verbless grammar exists to prevent.
		if (reserved === "add") return parseTuiValue(args, tokens.slice(1));
	}

	if (tokens.length === 0) return { subcommand: "help" };

	const subcommand = SECRET_VERB_SPELLINGS[tokens[0].value.toLowerCase()];
	if (subcommand === undefined) {
		// THE WORD IS NOT REPEATED. An unknown first token is most often an inline credential: this
		// surface has no field to hide one in, so a client or a `-p` invocation typing `/secret ghp_…`
		// lands here, and echoing it would write the credential into the refusal, the scrollback and
		// the saved transcript. The usage below is the actionable half anyway, because it names every
		// word this surface does run.
		throw new Error(`Unknown /secret subcommand.\n\n${usageText}`);
	}

	const request: SecretCommandRequest = { subcommand };

	const positional: string[] = [];
	const suppliedOptions = new Set<string>();
	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i].value;
		if (SECRET_COMMAND_OPTIONS[token]) {
			if (!SECRET_SUBCOMMAND_SHAPES[request.subcommand].options.includes(token)) {
				throw irrelevantOption(request.subcommand, token, usageText);
			}
			if (suppliedOptions.has(token)) {
				throw new Error(`${token} may be supplied only once; duplicate security options are refused.`);
			}
			suppliedOptions.add(token);

			const value = tokens[++i]?.value;
			if (token === "--from-env") {
				if (value === undefined || value.startsWith("--")) {
					throw new Error("--from-env needs the name of an environment variable.");
				}
				request.fromEnv = value;
			} else if (token === "--ttl") {
				if (value === undefined || value.startsWith("--")) {
					throw new Error("--ttl needs a lifetime, such as 7d or never.");
				}
				// No try/catch. `parseTtl` owns the wording for every way a lifetime can be wrong and no
				// longer echoes the value, so both verbs explain the same mistake the same way. The
				// `add`-only rewrite that used to live here existed to blunt that echo and cost the
				// distinction between "not a lifetime", "expires immediately" and "too large".
				request.ttl = parseTtl(value);
			} else if (token === "--limit") {
				const parsed = Number(value);
				if (value === undefined || value.startsWith("--") || !Number.isInteger(parsed) || parsed <= 0) {
					// Not quoted, for the reason `refuseExtraWords` explains: a misplaced credential reaches
					// here too, and this used to echo it for every verb except `add`. The `add`-only
					// suppression it replaces also made the branch below unreachable, since `add` does not
					// take --limit and the ownership guard rejects it first.
					throw new Error("--limit needs a positive whole number.");
				}
				request.limit = parsed;
			} else if (token === "--name") {
				if (value === undefined || value.startsWith("--")) {
					throw new Error("--name needs the name of a stored secret.");
				}
				request.name = normaliseSecretName(value);
			} else {
				if (value !== "profile" && value !== "project" && value !== "global") {
					throw new Error("--scope must be profile, project or global.");
				}
				request.scope = value;
			}
			continue;
		}

		if (token.startsWith("--")) {
			if (request.subcommand === "add" && request.name !== undefined) throw ambiguousInlineCredential();
			throw new Error(`Unknown option "${token}".\n\n${usageText}`);
		}

		if (request.subcommand === "add") {
			if (request.name === undefined) {
				request.name = token;
				positional.push(token);
				continue;
			}

			// The first bare word after the name starts the credential. From this byte onward an
			// option-looking word has two valid readings: command syntax or credential data. Never
			// guess between them, because guessing syntax silently truncates the stored credential.
			const valueStart = tokens[i - 1].end + 1;
			if (tokens.slice(i + 1).some(candidate => candidate.value.startsWith("--"))) {
				throw ambiguousInlineCredential();
			}
			request.value = args.slice(valueStart);
			positional.push(token);
			break;
		}

		positional.push(token);
	}

	if (request.subcommand !== "add" && positional.length > 0) request.name = positional[0];
	// The SECOND word, for the two verbs that take one. Read here rather than inside the loop so
	// `refuseExtraWords` still sees the whole positional list and refuses a third word.
	if (request.subcommand === "rename" && positional.length > 1) request.newName = positional[1];
	if (request.subcommand === "scope" && positional.length > 1) {
		// Validated here rather than in the runner, because a destination that is not a vault is a
		// malformed line and the parser is where a malformed line is refused. The scope words are a
		// closed set of three, so a positional cannot be mistaken for anything else.
		const to = positional[1].toLowerCase();
		if (to !== "profile" && to !== "project" && to !== "global") {
			throw new Error(`Which vault? /secret scope <name> profile|project|global.\n\n${usageText}`);
		}
		request.scope = to;
	}

	refuseExtraWords(request, positional, usageText, surface);
	refuseMissingScope(request, usageText);
	return request;
}

/** Refuse without quoting any byte that might itself be part of the credential. */
function ambiguousInlineCredential(): Error {
	return new Error(
		`An inline credential containing an option-shaped word is ambiguous and was not read. ` +
			`Put every option before the secret name, or use --from-env.`,
	);
}

/**
 * Refuse a bare word the subcommand does not read.
 *
 * THE SAME BUG AS THE OPTION GUARD, in the shape people actually type it: `/secret log 50` is the
 * natural way to ask for fifty records, and it used to parse the `50` into `request.name`, which
 * `showLog` does not read, so the command printed the default twenty and said nothing. The operator
 * concludes twenty is all there is. `/secret rm NAME extra` was the same, quietly discarding the
 * extra as a value nothing wanted.
 *
 * The message names the option that does what the word was reaching for, where there is one, because
 * "too many arguments" does not tell somebody who typed `/secret log 50` to type `--limit 50`.
 *
 * IT DOES NOT QUOTE THE WORD, because on a `/secret` line the extra word is very often the
 * credential. The realistic slip is muscle memory for `add` with a different verb: `/secret extend
 * TOK sk-live-...`, `/secret rm TOK sk-live-...`, or the value appended to a bare `/secret list`.
 * Quoting it wrote the credential into the error, which lands in the scrollback and in the saved
 * transcript, so the one command whose entire purpose is keeping credentials off the screen put one
 * there permanently. Verified by hand across every verb before this changed. Naming the POSITION
 * tells the operator what to remove without repeating the secret back at them.
 *
 * IN A TERMINAL IT ALSO NAMES THE ESCAPE, because the second reading of every one of those lines is
 * "this is a credential that starts with a reserved word", and the operator who meant that has to
 * be told the one spelling that expresses it. Not on the noninteractive surface, where the value
 * arrives as `add <name> --from-env VAR` and there is no bare-value form to escape into.
 */
function refuseExtraWords(
	request: SecretCommandRequest,
	words: readonly string[],
	usageText: string,
	surface: SecretCommandSurface,
): void {
	const shape = SECRET_SUBCOMMAND_SHAPES[request.subcommand];
	if (words.length <= shape.words) return;

	const extra = words[shape.words];
	// Digits are the one shape that cannot be a credential worth protecting AND is the shape the
	// hint needs to be useful, so `/secret log 50` still gets told to write `--limit 50`.
	const countedHint = /^[0-9]+$/.test(extra) ? extra : undefined;
	const hint =
		request.subcommand === "log" ? ` To show more records, write /secret log --limit ${countedHint ?? "50"}.` : "";
	const escapeHint =
		surface === "tui"
			? ` If the line is itself a credential that begins with /secret ${request.subcommand}, store it with ` +
				`/secret add <value>.`
			: "";
	const position = shape.words === 0 ? "the extra word" : `the word after the ${ordinalWord(shape.words)}`;
	throw new Error(
		`/secret ${request.subcommand} takes ${shape.words === 0 ? "no arguments" : `${shape.words} argument(s)`}, ` +
			`and ${position} would be ignored rather than used, so it was refused instead. The word itself is ` +
			`not repeated here, in case it is the credential.${hint}${escapeHint}\n\n${usageText}`,
	);
}

/** Name a positional slot in the refusal above without echoing what sits in it. */
function ordinalWord(count: number): string {
	const names: Record<number, string> = { 1: "first", 2: "second", 3: "third" };
	return names[count] ?? `${count}th`;
}

/**
 * Refuse a verb that needs a scope and was given none, rather than defaulting one.
 *
 * EVERY OTHER USE of `--scope` names where to PUT something and defaults to profile, where a wrong
 * guess costs you a secret stored in the wrong place and `/secret list` shows you that. The three
 * verbs below select something that already exists -- a file to move aside, a vault to empty, a
 * destination to move a secret into -- so a default acts on whichever one happened to be in front.
 *
 * WHICH verbs those are is read from `SECRET_SUBCOMMAND_SHAPES.needsScope` rather than from this
 * chain, so the grammar suites and this guard cannot hold different lists. The sentences stay
 * per-verb because the reason differs, and a verb that declares the requirement without one is
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
			`/secret clear needs the vault to empty, such as /secret clear --scope profile. There is no ` +
				`default: a credential you can reach is the narrowest copy of it, so a guessing /secret clear ` +
				`would empty whichever vault happens to be in front and leave the other two full.` +
				`\n\n${usageText}`,
		);
	}
	if (request.subcommand === "discard") {
		throw new Error(
			`/secret discard needs the scope whose vault file you want moved aside, such as ` +
				`/secret discard --scope project. There is no default, because discarding a scope you did ` +
				`not mean would move a working vault out from under this session.\n\n${usageText}`,
		);
	}
	// Declared as needing a scope, with no sentence written for it. Refusing generically is the only
	// safe reading: accepting the request would act on a vault the operator never named.
	throw new Error(
		`/secret ${request.subcommand} needs the vault to act on, such as ` +
			`/secret ${request.subcommand} --scope profile. There is no default.\n\n${usageText}`,
	);
}

/**
 * Which verbs read an option, in table order.
 *
 * ONE OWNER for a fact that had two: the refusal sentence derived it from the shape table while the
 * usage footer stated it as prose ("on add, rm and discard"), so a verb that gained `--scope` moved
 * one and left the other describing a surface that no longer existed. The footer is now built from
 * this, which is also the reason it takes bare verb names and lets each caller add its own prefix.
 */
function subcommandsTaking(option: string): SecretSubcommand[] {
	return (Object.keys(SECRET_SUBCOMMAND_SHAPES) as SecretSubcommand[]).filter(candidate =>
		SECRET_SUBCOMMAND_SHAPES[candidate].options.includes(option),
	);
}

/**
 * "a", "a and b", "a, b and c".
 *
 * Joined by hand rather than with `join(" and ")`, which was correct only while no option was read
 * by more than two subcommands: `--scope` reaching a third turned the sentence into "add and rm and
 * discard". `Intl.ListFormat` would also do this, and is not used because its output moves with
 * locale data, while this string is pinned byte for byte and read by an operator who has just been
 * refused.
 */
function joinWithAnd(items: readonly string[]): string {
	return items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Build the ownership error before parsing an option value the subcommand cannot use. */
function irrelevantOption(subcommand: SecretSubcommand, option: string, usageText: string): Error {
	const takenBy = subcommandsTaking(option);
	const named = joinWithAnd(takenBy.map(verb => `/secret ${verb}`));
	return new Error(
		`/secret ${subcommand} does not take ${option}, and ignoring it would look like it had ` +
			`been applied. ${named} take${takenBy.length === 1 ? "s" : ""} it.` +
			`\n\n${usageText}`,
	);
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
	if (request.scope === undefined) throw new Error("Which scope? /secret discard --scope project");

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
		throw new Error("Give either --from-env or a value, not both.");
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
					`  /secret add ${request.name ?? "<name>"} --from-env MY_TOKEN`,
			);
		}
		throw new Error(
			`No value given, and this client cannot prompt for one without showing it. ` +
				`Name an environment variable to read it from:\n` +
				`  /secret --from-env MY_TOKEN\n` +
				`or type the value after /secret, keeping in mind it stays visible in your scrollback.`,
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
const LIST_EXPIRY_FOOTER = "Extend one before it lapses: /secret extend <name> --ttl 7d.";

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
	`${OUTPUT_INDENT}${USAGE_TUI_INLINE}`,
	`${OUTPUT_INDENT}${USAGE_TUI_MASKED}`,
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
				`${OUTPUT_INDENT}Only the ${winner} copy is spent. Remove it with /secret rm ${entry.name} --scope ${entry.scope}.`,
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
	const commands = unreadable.map(scope => `/secret discard --scope ${scope}`).join(" and ");
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
				`Run /secret rm ${name} --scope ${spentNow.scope} to remove that one too.`,
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
		throw new Error("Which vault? /secret clear --scope profile");
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
	if (request.name === undefined) throw new Error("Which secret? /secret extend <name> --ttl 7d");

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
 * `add` and `value` both take `--from-env` and a refusal worded differently between them would be
 * two diagnoses of one mistake.
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
		throw new Error("Give either --from-env or a value, not both.");
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
				`Name an environment variable to read it from:\n  /secret value ${name} --from-env MY_TOKEN`,
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
				`already lapsed. Store it again with /secret --scope ${request.scope} instead.`,
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
	// a `--limit 20` did not already cost.
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
				`Extend it with /secret extend ${entry.name} --ttl 7d, or it will be deleted.`,
		);
	}
	return warnings;
}
