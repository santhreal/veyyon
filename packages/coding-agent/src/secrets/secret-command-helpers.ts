import {
	assignSlot,
	joinWithAnd,
	matchTrailing,
	refuseExtraWord,
	refuseMissingScope,
	refuseMissingWords,
	refuseRepeatedWord,
	subcommandsWithSlot,
} from "./secret-command";
import type { VaultScope } from "./vault";

export type SecretSubcommand =
	| "add"
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

export const DEFAULT_LOG_LIMIT = 20;

export interface SecretCommandRequest {
	subcommand: SecretSubcommand;
	name?: string;
	newName?: string;
	value?: string;
	fromEnv?: string;
	scope?: VaultScope;
	allScopes?: true;
	ttl?: number | null;
	limit?: number;
	maskedEntry?: boolean;
}

export const SECRET_ENTRY_COMMANDS: readonly SecretSubcommand[] = ["add", "from-env"];

export function needsValuePrompt(request: SecretCommandRequest): boolean {
	return (
		(request.subcommand === "add" || request.subcommand === "value") &&
		request.value === undefined &&
		request.fromEnv === undefined
	);
}

export interface SecretCommandResult {
	message: string;
	agentNotice?: string;
	agentNoticeIsRevocation?: true;
	copyText?: string;
	changed: boolean;
}

export type SecretCommandSurface = "tui" | "noninteractive";

export const USAGE_TUI_MASKED = "/secret add                           paste into a hidden field";
export const USAGE_TUI_INLINE = "/secret add <value>                   store it now, then name it (optional)";
export const USAGE_TUI_FROM_ENV = "/secret from-env <VAR> [<name>]       store the value of an environment variable";
export const USAGE_ADD_FROM_ENV = "/secret from-env <VAR> <name>         store the value of an environment variable";
export const USAGE_CLIENT_ADD =
	"/secret add                           not here: a client cannot hide typing, so use from-env";

export type SecretSlot = "name" | "newName" | "variable" | "scope" | "ttl" | "limit";

export const SECRET_SUBCOMMAND_SHAPES: Record<
	SecretSubcommand,
	{ slots: readonly SecretSlot[]; required: number; trailing: readonly SecretSlot[]; needsScope: boolean }
> = {
	add: { slots: [], required: 0, trailing: [], needsScope: false },
	"from-env": { slots: ["variable", "name"], required: 2, trailing: ["ttl", "scope"], needsScope: false },
	list: { slots: [], required: 0, trailing: [], needsScope: false },
	rm: { slots: ["name"], required: 1, trailing: ["scope"], needsScope: false },
	clear: { slots: ["scope"], required: 1, trailing: [], needsScope: true },
	rename: { slots: ["name", "newName"], required: 2, trailing: [], needsScope: false },
	value: { slots: ["name"], required: 1, trailing: ["variable"], needsScope: false },
	scope: { slots: ["name", "scope"], required: 2, trailing: [], needsScope: true },
	copy: { slots: ["name"], required: 1, trailing: [], needsScope: false },
	extend: { slots: ["name", "ttl"], required: 2, trailing: [], needsScope: false },
	log: { slots: [], required: 0, trailing: ["name", "limit"], needsScope: false },
	discard: { slots: ["scope"], required: 1, trailing: [], needsScope: true },
	help: { slots: [], required: 0, trailing: [], needsScope: false },
};

export const USAGE_LIST = "/secret list                          show active secrets, never their values";
export const USAGE_INSPECT = [
	USAGE_LIST,
	"/secret log [<name>] [50]             show which secrets were used, and where",
	"/secret copy <name>                   copy #NAME#, the placeholder, never the value",
];
export const USAGE_EDIT = [
	"/secret value <name>                  replace a secret's value, keeping its name and lifetime",
	"/secret rename <name> <new-name>      give a secret a different name",
	"/secret extend <name> 7d              give a secret a fresh lifetime",
	"/secret scope <name> global           move a secret to another vault",
];
export const USAGE_REMOVE = [
	"/secret rm <name> [global]            remove one secret",
	"/secret clear profile                 remove every secret in one vault",
	"/secret clear everywhere              remove every secret, in all three vaults",
	"/secret discard project               move a vault file aside when it cannot be read",
];

export const USAGE_FOOTER_SCOPES =
	"Lifetimes default to the secrets.defaultTtl setting. Scope defaults to profile; project overrides profile, which overrides global.";

export const footerShape = (shape: string, tail: string): string => `${shape.padEnd(37)}${tail}`;

export const USAGE_FOOTER = [
	footerShape("30m|12h|7d|2w|never", `a lifetime, on ${joinWithAnd(subcommandsWithSlot("ttl"))}`),
	footerShape("profile|project|global", `a vault, on ${joinWithAnd(subcommandsWithSlot("scope"))}`),
	USAGE_FOOTER_SCOPES,
	"Removal without a vault takes the narrowest match, which is the one currently in effect.",
];

export const OUTPUT_INDENT = "  ";

export const SCROLLBACK_WARNING =
	"The value was typed on screen, so it is in your scrollback. Use /secret from-env next time to avoid that.";

function buildUsage(entryLines: readonly string[], footerLines: readonly string[]): string {
	const groups: ReadonlyArray<readonly [string, readonly string[]]> = [
		["Store a credential the agent can use without ever seeing it:", entryLines],
		["See what you have:", USAGE_INSPECT],
		["Change one secret:", USAGE_EDIT],
		["Remove secrets:", USAGE_REMOVE],
	];
	const lines: string[] = [];
	for (const [heading, entries] of groups) {
		lines.push(heading, ...entries.map(entry => `${OUTPUT_INDENT}${entry}`), "");
	}
	for (let li = 0; li < footerLines.length; li++) lines.push(footerLines[li]!);
	return lines.join("\n");
}

export const SECRET_COMMAND_USAGE = buildUsage([USAGE_TUI_MASKED, USAGE_TUI_INLINE, USAGE_TUI_FROM_ENV], USAGE_FOOTER);

export const NONINTERACTIVE_SECRET_COMMAND_USAGE = buildUsage([USAGE_ADD_FROM_ENV, USAGE_CLIENT_ADD], USAGE_FOOTER);

export function secretCommandUsage(surface: SecretCommandSurface): string {
	return surface === "tui" ? SECRET_COMMAND_USAGE : NONINTERACTIVE_SECRET_COMMAND_USAGE;
}

export const SECRET_VERB_SPELLINGS: Record<string, SecretSubcommand> = {
	add: "add",
	"from-env": "from-env",
	env: "from-env",
	list: "list",
	rm: "rm",
	remove: "rm",
	delete: "rm",
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
	discard: "discard",
	help: "help",
};

export const SECRET_TUI_SUBCOMMAND_HELP: Record<SecretSubcommand, { usage: string; description: string }> = {
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

export const SECRET_TUI_SUBCOMMANDS: readonly { name: SecretSubcommand; usage: string; description: string }[] =
	Object.entries(SECRET_VERB_SPELLINGS)
		.filter(([word, subcommand]) => word === subcommand)
		.map(([, subcommand]) => ({ name: subcommand, ...SECRET_TUI_SUBCOMMAND_HELP[subcommand] }));

export const REMOVED_OPTION_SPELLINGS: readonly string[] = [
	"--",
	"--from-env",
	"--ttl",
	"--scope",
	"--limit",
	"--name",
];

export interface SecretToken {
	value: string;
	start: number;
	end: number;
}

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

	return { subcommand: "add", value: args.slice(tokens[0].start, tokens[tokens.length - 1].end) };
}

export function parseSecretCommand(args: string, surface: SecretCommandSurface = "tui"): SecretCommandRequest {
	const usageText = secretCommandUsage(surface);
	const tokens = Array.from(args.matchAll(/\S+/gu)).map(match => ({
		value: match[0],
		start: match.index,
		end: match.index + match[0].length,
	}));

	if (surface === "tui" && tokens.length > 0) {
		const leading = SECRET_VERB_SPELLINGS[tokens[0].value.toLowerCase()];
		if (leading === "add") return parseTuiValue(args, tokens.slice(1));
	}

	if (tokens.length === 0) return { subcommand: "help" };

	const subcommand = SECRET_VERB_SPELLINGS[tokens[0].value.toLowerCase()];
	if (subcommand === undefined) {
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

	if (surface === "noninteractive" && subcommand === "add" && words.length > 0) {
		throw new Error(
			`This client refuses an inline credential, because the line carrying it is retained in the ` +
				`client's own request history. Nothing was stored. Read the value out of the environment ` +
				`instead: /secret from-env MY_TOKEN <name>.\n\n${usageText}`,
		);
	}
	const required = surface === "tui" && subcommand === "from-env" ? 1 : shape.required;

	let index = 0;
	for (const slot of shape.slots) {
		if (index >= words.length) break;
		if (index >= required && matchTrailing(shape.trailing, words[index]) !== undefined) break;
		assignSlot(request, slot, words, index, usageText);
		index += 1;
	}

	if (index < required) {
		refuseMissingScope(request, usageText);
		throw refuseMissingWords(subcommand, shape, required, index, usageText);
	}

	const filled = new Set<SecretSlot>();
	while (index < words.length) {
		const slot = matchTrailing(shape.trailing, words[index]);
		if (slot === undefined) throw refuseExtraWord(request, shape, index, words, surface, usageText);
		if (filled.has(slot)) throw refuseRepeatedWord(subcommand, slot, surface, usageText);
		filled.add(slot);
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
