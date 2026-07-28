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
import { errorMessage } from "@veyyon/utils";
import type { SecretAuditLog, SecretExpansionRecord } from "./audit";
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
export type SecretSubcommand = "add" | "list" | "rm" | "extend" | "log" | "help";

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
	 */
	agentNotice?: string;
	/** True when the vault changed, so the caller can refresh the obfuscator. */
	changed: boolean;
}

/** The two command-help surfaces have different safe credential-entry capabilities. */
export type SecretCommandSurface = "tui" | "noninteractive";

/** TUI help may describe masked entry and explicit inline entry. */
export const SECRET_COMMAND_USAGE = [
	"/secret add <name>                    prompt for the value, hidden as you type",
	"/secret add <name> --from-env <VAR>   store the value of an environment variable",
	"/secret add <name> <value>            store a value directly (visible on screen)",
	"/secret list                          show stored secrets, never their values",
	"/secret rm <name>                     remove a secret",
	"/secret extend <name> --ttl 7d        give a secret a fresh lifetime",
	"/secret log [--limit 50]              show which secrets were used, and where",
	"",
	"Options: --ttl 30m|12h|7d|2w|never   --scope profile|project|global",
	"Lifetimes default to the secrets.defaultTtl setting. Scope defaults to profile.",
].join("\n");

/** Noninteractive help exposes only environment-backed creation and management. */
export const NONINTERACTIVE_SECRET_COMMAND_USAGE = [
	"/secret add <name> --from-env <VAR>   store the value of an environment variable",
	"/secret list                          show stored secrets, never their values",
	"/secret rm <name>                     remove a secret",
	"/secret extend <name> --ttl 7d        give a secret a fresh lifetime",
	"/secret log [--limit 50]              show which secrets were used, and where",
	"",
	"Options: --ttl 30m|12h|7d|2w|never   --scope profile|project|global",
	"Lifetimes default to the secrets.defaultTtl setting. Scope defaults to profile.",
].join("\n");

/** Select help that matches what the invoking surface can enter safely. */
export function secretCommandUsage(surface: SecretCommandSurface): string {
	return surface === "tui" ? SECRET_COMMAND_USAGE : NONINTERACTIVE_SECRET_COMMAND_USAGE;
}

/** Every option token the command grammar owns. */
const SECRET_COMMAND_OPTIONS: Record<string, true> = {
	"--from-env": true,
	"--ttl": true,
	"--limit": true,
	"--scope": true,
};

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
			throw new Error(`Unknown /secret subcommand "${tokens[0].value}".\n\n${usageText}`);
	}

	const positional: string[] = [];
	const suppliedOptions = new Set<string>();
	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i].value;
		if (SECRET_COMMAND_OPTIONS[token]) {
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

	refuseIrrelevantOptions(request, usageText);
	refuseExtraWords(request, positional, usageText);
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
 * What each subcommand actually reads: its options, and how many bare words it takes.
 *
 * The ONE owner of that mapping, declared as data rather than checked with a chain of `if`s, so the
 * usage text, the error messages and the guards cannot describe three different sets of rules.
 *
 * `words` is how many bare words the subcommand reads. `add` is UNBOUNDED, and that is not laziness:
 * its second argument is a credential, whose untouched raw suffix is retained so a passphrase keeps
 * repeated whitespace and quotes. Counting words for `add` would refuse
 * `/secret add gpg "my long pass phrase"` as five arguments when it is two.
 */
const SUBCOMMAND_SHAPES: Record<SecretSubcommand, { options: readonly string[]; words: number }> = {
	add: { options: ["--from-env", "--ttl", "--scope"], words: Number.POSITIVE_INFINITY },
	list: { options: [], words: 0 },
	rm: { options: [], words: 1 },
	extend: { options: ["--ttl"], words: 1 },
	log: { options: ["--limit"], words: 0 },
	help: { options: [], words: 0 },
};

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
 * Refuse an option the subcommand does not read, instead of accepting and ignoring it.
 *
 * THE BUG THIS CLOSES. Every option parsed above was accepted for every verb, and each subcommand
 * then read only the fields it cared about, so `/secret extend NAME --scope global` reported
 * success and did nothing about the scope, and `/secret rm NAME --scope project` looked like it
 * removed the project copy while actually removing whichever one was in effect. That is a silent
 * no-op on a security command, which is the worst place for one: the operator comes away believing
 * a credential moved or was removed from somewhere it still exists.
 *
 * Refusing names the verb that does take the option, so the message teaches the right command
 * rather than just rejecting the wrong one.
 */
function refuseIrrelevantOptions(request: SecretCommandRequest, usageText: string): void {
	const allowed = SUBCOMMAND_SHAPES[request.subcommand].options;
	const supplied: [string, boolean][] = [
		["--from-env", request.fromEnv !== undefined],
		["--ttl", request.ttl !== undefined],
		["--scope", request.scope !== undefined],
		["--limit", request.limit !== undefined],
	];
	for (const [option, wasGiven] of supplied) {
		if (!wasGiven || allowed.includes(option)) continue;
		const takenBy = (Object.keys(SUBCOMMAND_SHAPES) as SecretSubcommand[]).filter(subcommand =>
			SUBCOMMAND_SHAPES[subcommand].options.includes(option),
		);
		throw new Error(
			`/secret ${request.subcommand} does not take ${option}, and ignoring it would look like it had ` +
				`been applied. ${takenBy.map(verb => `/secret ${verb}`).join(" and ")} take${takenBy.length === 1 ? "s" : ""} it.` +
				`\n\n${usageText}`,
		);
	}
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
	}
}

async function addSecret(
	request: SecretCommandRequest,
	context: {
		vault: SecretVault;
		readEnv: (name: string) => string | undefined;
		defaultTtl: number | null;
		now: number;
	},
): Promise<SecretCommandResult> {
	if (request.fromEnv !== undefined && request.value !== undefined) {
		throw new Error("Give either --from-env or a value, not both.");
	}

	let value: string;
	let typedOnScreen: boolean;
	if (request.fromEnv !== undefined) {
		const fromEnv = context.readEnv(request.fromEnv);
		if (fromEnv === undefined || fromEnv.length === 0) {
			throw new Error(
				`The environment variable ${request.fromEnv} is not set in this process, so there is nothing to store. ` +
					`Note that it must be set for the veyyon process, not only in a shell you opened afterwards.`,
			);
		}
		value = fromEnv;
		typedOnScreen = false;
	} else if (request.value !== undefined) {
		value = request.value;
		typedOnScreen = request.maskedEntry !== true;
	} else {
		// Reached only where there is no terminal to mask. An interactive session opens a hidden
		// field instead of showing this (see `needsValuePrompt`), so the advice here is for
		// clients that cannot prompt at all.
		throw new Error(
			`No value given, and this client cannot prompt for one without showing it. ` +
				`Name an environment variable to read it from:\n` +
				`  /secret add ${request.name ?? "<name>"} --from-env MY_TOKEN\n` +
				`or pass the value directly, keeping in mind it stays visible in your scrollback.`,
		);
	}

	const ttl = request.ttl === undefined ? context.defaultTtl : request.ttl;
	const entry = await context.vault.add({ name: request.name, value, scope: request.scope, ttl });

	const lines = [
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
			`ask for it. Do not echo #${entry.name}# into a file or a message where it is not needed.`,
		changed: true,
	};
}

async function listSecrets(context: { vault: SecretVault; now: number }): Promise<SecretCommandResult> {
	const entries = await context.vault.load();
	if (entries.length === 0) {
		return { message: "No secrets stored. Add one with /secret add <name> --from-env <VAR>.", changed: false };
	}

	const rows = [...entries]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(entry => `  #${entry.name}#  ${entry.scope}  ${describeTimeLeft(entry, context.now)}`);

	// Values are deliberately absent, not truncated. A prefix of a credential is still a
	// disclosure, and `list` exists to answer "what do I have", not "what is it".
	return { message: [`${entries.length} secret(s):`, ...rows].join("\n"), changed: false };
}

async function removeSecret(
	request: SecretCommandRequest,
	context: { vault: SecretVault },
): Promise<SecretCommandResult> {
	if (request.name === undefined) throw new Error("Which secret? /secret rm <name>");

	const scope = await context.vault.remove(request.name);
	if (scope === null) {
		return { message: `No secret named ${normaliseSecretName(request.name)} is stored.`, changed: false };
	}
	return { message: `Removed ${normaliseSecretName(request.name)} from the ${scope} vault.`, changed: true };
}

async function extendSecret(
	request: SecretCommandRequest,
	context: { vault: SecretVault; defaultTtl: number | null; now: number },
): Promise<SecretCommandResult> {
	if (request.name === undefined) throw new Error("Which secret? /secret extend <name> --ttl 7d");

	const ttl = request.ttl === undefined ? context.defaultTtl : request.ttl;
	const entry = await context.vault.extend(request.name, ttl);
	if (entry === null) {
		return { message: `No secret named ${normaliseSecretName(request.name)} is stored.`, changed: false };
	}
	return {
		message: `${entry.name} now lasts ${formatTtl(ttl)} from now (${describeTimeLeft(entry, context.now)}).`,
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

/**
 * Warnings for secrets far enough through their lifetime to be worth mentioning.
 *
 * THROUGH `warningThresholdCrossed`, NOT ITS OWN ARITHMETIC. This function used to compare
 * against an inline `0.9` while `WARN_AT_FRACTIONS` said `[0.5, 0.9]`, so there were two owners
 * of "when do we warn" and they disagreed: the halfway warning the setting promised was never
 * raised by anything. One owner now, and a new threshold added to the list takes effect here
 * without a second edit.
 *
 * Each line names the remedy, because a warning you cannot act on is noise. Expiry deletes the
 * value, so the action is to extend it before that happens rather than after.
 */
export function expiryWarnings(entries: readonly ScopedVaultEntry[], now: number): string[] {
	const warnings: string[] = [];
	// The LAST fraction in the list is the urgent one, read from the list rather than written here
	// as a literal. An inline `0.9` was the original bug in this function, and repeating it in the
	// wording would have re-created it one level down: adding a 0.99 threshold would then have
	// produced "over halfway through its lifetime" for a secret with minutes left.
	const urgentFraction = WARN_AT_FRACTIONS[WARN_AT_FRACTIONS.length - 1];
	for (const entry of entries) {
		const crossed = warningThresholdCrossed(entry, now);
		if (crossed === null) continue;
		const urgency = crossed >= urgentFraction ? "expires soon" : "is over halfway through its lifetime";
		warnings.push(
			`#${entry.name}# ${urgency}, ${describeTimeLeft(entry, now)}. ` +
				`Extend it with /secret extend ${entry.name} --ttl 7d, or it will be deleted.`,
		);
	}
	return warnings;
}
