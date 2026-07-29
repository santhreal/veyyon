/**
 * What `/secret` does, as pure logic over a vault.
 *
 * SEPARATE FROM THE REGISTRY ON PURPOSE. Domain logic does not import the CLI or the TUI, so
 * every rule below is testable without constructing a session, and the registry handler is a
 * thin adapter that parses a line and prints a string. The alternative, putting this inside
 * the 2000-line builtin registry, would make the security-relevant behaviour reachable only
 * through a live TUI.
 *
 * WHY THE VALUE IS NOT A POSITIONAL ARGUMENT AFTER THE NAME. `/secret add <value> <name>` is
 * unparseable: a credential is arbitrary text, so optional positionals after it have no unique
 * reading (`/secret add abc123 prod 7d` could be a secret of `abc123` or of `abc123 prod 7d`,
 * and passphrases contain spaces). Options are therefore flags, and the name comes first.
 *
 * WHERE THE VALUE COMES FROM, in order of how much it leaks:
 *   - `--from-env VAR` reads it out of the environment. The credential is never typed, so it
 *     never enters the input buffer or the scrollback. This is the recommended form and the
 *     only one that works in a non-interactive client.
 *   - an inline value is accepted, because refusing it would mean you cannot store a
 *     credential that is not already in your environment. It is visible on screen until the
 *     editor is cleared, so {@link addSecret} says so in its confirmation rather than leaving
 *     the user to assume otherwise.
 */
import { Ellipsis, padding, sanitizeSingleLine, truncateToWidth, visibleWidth } from "@veyyon/tui/utils";
import { errorMessage, formatCount } from "@veyyon/utils";
import type { SecretAuditLog, SecretExpansionRecord } from "./audit";
import { MAX_SECRET_NAME_LENGTH } from "./placeholder";
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

/** Every subcommand `/secret` understands. */
export type SecretSubcommand = "add" | "list" | "rm" | "extend" | "log" | "discard" | "help";

/** How many log lines `/secret log` shows when the operator does not say. */
export const DEFAULT_LOG_LIMIT = 20;

/** A parsed `/secret` invocation. */
export interface SecretCommandRequest {
	subcommand: SecretSubcommand;
	name?: string;
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
	return request.subcommand === "add" && request.value === undefined && request.fromEnv === undefined;
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
 */
const USAGE_ADD_MASKED = "/secret add <name>                    prompt for the value, hidden as you type";
const USAGE_ADD_FROM_ENV = "/secret add <name> --from-env <VAR>   store the value of an environment variable";
const USAGE_ADD_INLINE = "/secret add <name> <value>            store a value directly (visible on screen)";

/** Reading what is stored. Grouped with `add` because between them they are the everyday path. */
const USAGE_LIST = "/secret list                          show active secrets, never their values";

/** Everything you only need once a secret exists, kept out of the way of the two above. */
const USAGE_MANAGE = [
	"/secret rm <name>                     remove a secret",
	"/secret extend <name> --ttl 7d        give a secret a fresh lifetime",
	"/secret log [--limit 50]              show which secrets were used, and where",
	"/secret discard --scope project       move a broken vault file aside",
];

/** Applies to every subcommand, so it sits under both groups rather than inside either. */
const USAGE_FOOTER = [
	"Options: --ttl 30m|12h|7d|2w|never   --scope profile|project|global",
	"Lifetimes default to the secrets.defaultTtl setting. Scope defaults to profile; project overrides profile, which overrides global.",
];

/**
 * Two spaces in front of every line `/secret` indents: usage entries, `list` table rows, the
 * suggestions an empty vault prints. ONE owner, so the command's output reads as one report
 * rather than three that nearly line up.
 */
const OUTPUT_INDENT = "  ";

/**
 * Help, grouped: what you do every day first, management second.
 *
 * The flat list this replaced gave `rm`, `extend` and `log` exactly the weight of `add`, so the
 * one line a new operator needs was the fourth of seven with nothing separating them. Both
 * surfaces are built from the same call, so the grouping cannot be applied to one and forgotten
 * on the other.
 */
function buildUsage(addLines: readonly string[]): string {
	const groups: ReadonlyArray<readonly [string, readonly string[]]> = [
		["Store a credential the agent can use without ever seeing it:", [...addLines, USAGE_LIST]],
		["Manage what is already stored:", USAGE_MANAGE],
	];
	const lines: string[] = [];
	for (const [heading, entries] of groups) {
		// The blank line after each group is what makes the grouping visible at all.
		lines.push(heading, ...entries.map(entry => `${OUTPUT_INDENT}${entry}`), "");
	}
	lines.push(...USAGE_FOOTER);
	return lines.join("\n");
}

/** TUI help may describe masked entry and explicit inline entry. */
export const SECRET_COMMAND_USAGE = buildUsage([USAGE_ADD_MASKED, USAGE_ADD_FROM_ENV, USAGE_ADD_INLINE]);

/** Noninteractive help exposes only environment-backed creation and management. */
export const NONINTERACTIVE_SECRET_COMMAND_USAGE = buildUsage([USAGE_ADD_FROM_ENV]);

/** Select help that matches what the invoking surface can enter safely. */
export function secretCommandUsage(surface: SecretCommandSurface): string {
	return surface === "tui" ? SECRET_COMMAND_USAGE : NONINTERACTIVE_SECRET_COMMAND_USAGE;
}

/**
 * What each subcommand actually reads: its options, and how many bare words it takes.
 *
 * The ONE owner of that mapping, declared as data rather than checked with a chain of `if`s, so
 * parsing, error messages and guards cannot describe different sets of rules. `add` has unbounded
 * words because its second positional is the untouched credential suffix, not a word list.
 */
const SUBCOMMAND_SHAPES: Record<SecretSubcommand, { options: readonly string[]; words: number }> = {
	add: { options: ["--from-env", "--ttl", "--scope"], words: Number.POSITIVE_INFINITY },
	list: { options: [], words: 0 },
	rm: { options: [], words: 1 },
	extend: { options: ["--ttl"], words: 1 },
	log: { options: ["--limit"], words: 0 },
	// REQUIRED scope, so `words: 0` and the guard below. The scope names a FILE to move aside
	// rather than a place to store something, so there is no safe default to fall back on, and a
	// bare word here would read as a secret name, which is the mistake worth refusing outright.
	discard: { options: ["--scope"], words: 0 },
	help: { options: [], words: 0 },
};

/** Every known option, derived from its subcommand owners so the two cannot drift. */
const SECRET_COMMAND_OPTIONS: Record<string, true> = Object.fromEntries(
	Object.values(SUBCOMMAND_SHAPES).flatMap(shape => shape.options.map(option => [option, true] as const)),
);

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
	if (tokens.length === 0) return { subcommand: "help" };

	const verb = tokens[0].value.toLowerCase();
	const request: SecretCommandRequest = { subcommand: "help" };

	switch (verb) {
		case "add":
		case "list":
		case "rm":
		case "remove":
		case "delete":
		case "extend":
		case "renew":
		case "log":
		case "audit":
		// No alias. `rm` and `extend` have two natural spellings each; `discard` has no twin, and
		// inventing one for a destructive-looking repair only widens what a typo can reach.
		case "discard":
		case "help":
			request.subcommand =
				verb === "remove" || verb === "delete"
					? "rm"
					: verb === "renew"
						? "extend"
						: verb === "audit"
							? "log"
							: (verb as SecretSubcommand);
			break;
		default:
			throw new Error(`Unknown /secret subcommand.\n\n${usageText}`);
	}

	const positional: string[] = [];
	const suppliedOptions = new Set<string>();
	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i].value;
		if (SECRET_COMMAND_OPTIONS[token]) {
			if (!SUBCOMMAND_SHAPES[request.subcommand].options.includes(token)) {
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
				try {
					request.ttl = parseTtl(value);
				} catch (error) {
					if (request.subcommand !== "add") throw error;
					throw new Error("--ttl needs a valid lifetime, such as 7d or never.");
				}
			} else if (token === "--limit") {
				const parsed = Number(value);
				if (value === undefined || value.startsWith("--") || !Number.isInteger(parsed) || parsed <= 0) {
					throw new Error(
						request.subcommand === "add"
							? "--limit needs a positive whole number."
							: `--limit needs a positive whole number, not "${value ?? ""}".`,
					);
				}
				request.limit = parsed;
			} else {
				if (value !== "profile" && value !== "project" && value !== "global") {
					throw new Error(
						request.subcommand === "add"
							? "--scope must be profile, project or global."
							: `--scope must be profile, project or global, not "${value ?? ""}".`,
					);
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

	refuseExtraWords(request, positional, usageText);
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
 */
function refuseExtraWords(request: SecretCommandRequest, words: readonly string[], usageText: string): void {
	const shape = SUBCOMMAND_SHAPES[request.subcommand];
	if (words.length <= shape.words) return;

	const extra = words[shape.words];
	const hint =
		request.subcommand === "log"
			? ` To show more records, write /secret log --limit ${/^[0-9]+$/.test(extra) ? extra : "50"}.`
			: "";
	throw new Error(
		`/secret ${request.subcommand} takes ${shape.words === 0 ? "no arguments" : `${shape.words} argument(s)`}, ` +
			`and "${extra}" would be ignored rather than used.${hint}\n\n${usageText}`,
	);
}

/**
 * Refuse `/secret discard` with no scope, rather than defaulting it.
 *
 * EVERY OTHER USE of `--scope` names where to PUT something and defaults to profile, where a wrong
 * guess costs you a secret stored in the wrong place and `/secret list` shows you that. Here the
 * argument selects a FILE TO MOVE ASIDE, so a default would let a bare `/secret discard` move a
 * working vault out from under the session, and the operator asked for a repair rather than that.
 */
function refuseMissingScope(request: SecretCommandRequest, usageText: string): void {
	if (request.subcommand !== "discard" || request.scope !== undefined) return;
	throw new Error(
		`/secret discard needs the scope whose vault file you want moved aside, such as ` +
			`/secret discard --scope project. There is no default, because discarding a scope you did ` +
			`not mean would move a working vault out from under this session.\n\n${usageText}`,
	);
}

/** Build the ownership error before parsing an option value the subcommand cannot use. */
function irrelevantOption(subcommand: SecretSubcommand, option: string, usageText: string): Error {
	const takenBy = (Object.keys(SUBCOMMAND_SHAPES) as SecretSubcommand[]).filter(candidate =>
		SUBCOMMAND_SHAPES[candidate].options.includes(option),
	);
	return new Error(
		`/secret ${subcommand} does not take ${option}, and ignoring it would look like it had ` +
			`been applied. ${takenBy.map(verb => `/secret ${verb}`).join(" and ")} take${takenBy.length === 1 ? "s" : ""} it.` +
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
		case "extend":
			return await extendSecret(request, context);
		case "log":
			return await showLog(request, context);
		case "discard":
			return await discardVaultScope(request, context);
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
		const fromEnv = context.readEnv(request.fromEnv);
		// Set-but-empty is kept DISTINCT from unset, because collapsing the two told an operator that a
		// variable they had just exported "is not set", sending them to re-check an export that was
		// already there while the real cause was an assignment that set it to nothing. Each case gets
		// the fix that applies to it. Whitespace-only is refused rather than trimmed and stored:
		// nothing made only of spaces is a credential, and storing it would mint a placeholder that
		// spends blank text into a command. A value that merely CONTAINS surrounding space is stored
		// byte for byte, since a real credential is allowed to and trimming one would corrupt it.
		if (fromEnv === undefined) {
			throw new Error(
				`The environment variable ${request.fromEnv} is not set in this process, so there is nothing to store. ` +
					`Note that it must be set for the veyyon process, not only in a shell you opened afterwards.`,
			);
		}
		if (fromEnv.length === 0) {
			throw new Error(
				`The environment variable ${request.fromEnv} is set but empty, so there is no credential to store. ` +
					`Check where it is exported: an assignment such as ${request.fromEnv}= sets it to nothing.`,
			);
		}
		if (fromEnv.trim().length === 0) {
			throw new Error(
				`The environment variable ${request.fromEnv} contains only whitespace, so there is no credential to ` +
					`store. Storing it would create a placeholder that spends blank text.`,
			);
		}
		value = fromEnv;
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
				`  /secret add ${request.name ?? "<name>"} --from-env MY_TOKEN\n` +
				`or pass the value directly, keeping in mind it stays visible in your scrollback.`,
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
		lines.push(`The value was typed on screen, so it is in your scrollback. Use --from-env next time to avoid that.`);
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
	`${OUTPUT_INDENT}${USAGE_ADD_MASKED}`,
	`${OUTPUT_INDENT}${USAGE_ADD_FROM_ENV}`,
].join("\n");
const NONINTERACTIVE_EMPTY_VAULT_HELP = [...EMPTY_VAULT_PREAMBLE, `${OUTPUT_INDENT}${USAGE_ADD_FROM_ENV}`].join("\n");

async function listSecrets(context: {
	vault: SecretVault;
	now: number;
	surface?: SecretCommandSurface;
}): Promise<SecretCommandResult> {
	const entries = await context.vault.load();
	return {
		message: renderSecretList(entries, { now: context.now, surface: context.surface }),
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
	options: { now: number; surface?: SecretCommandSurface },
): string {
	const surface = options.surface ?? "tui";
	if (entries.length === 0) return surface === "tui" ? EMPTY_VAULT_HELP : NONINTERACTIVE_EMPTY_VAULT_HELP;

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
	return lines.join("\n");
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
	const scope = await context.vault.remove(request.name);
	if (scope === null) {
		throw new Error(`No secret named ${name} is stored. Run /secret list to see what is.`);
	}
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
	const { records, malformed } = await context.auditLog.read({ limit });
	return { message: renderLog(records, { malformed, path: context.auditLog.path, now: context.now }), changed: false };
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

/** "3m ago", for log rows. Coarse on purpose: the exact millisecond is in the file. */
function describeAgo(elapsedMs: number): string {
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
 * value, so the action is to extend it before that happens rather than after.
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
