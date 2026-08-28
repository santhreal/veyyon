import { parseCommandArgs } from "../../utils/command-args";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";

export interface ParsedSubcommand {
	verb: string;
	rest: string;
}

/** Parse a slash-invocation string into `name`/`args`. The separator is the earliest whitespace or `:` character so that both */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
	if (!text.startsWith("/")) return null;
	const body = text.slice(1);
	if (!body) return null;
	const firstWhitespace = body.search(/\s/);
	const firstColon = body.indexOf(":");
	const firstSeparator =
		firstWhitespace === -1 ? firstColon : firstColon === -1 ? firstWhitespace : Math.min(firstWhitespace, firstColon);
	if (firstSeparator === -1) return { name: body, args: "", text };
	return {
		name: body.slice(0, firstSeparator),
		args: body.slice(firstSeparator + 1).trimStart(),
		text,
	};
}

/** What a slash COMMAND may be called, as opposed to a path that merely starts with `/`. A leading slash is ambiguous: `/etc/hosts is broken` is an ordinary message about a file, while */
const COMMAND_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** The name of a command-shaped slash invocation that nothing was able to handle. Called after every resolver has had its turn (builtins, extension commands, custom commands, */
export function unresolvedSlashCommandName(text: string): string | undefined {
	const parsed = parseSlashCommand(text);
	if (!parsed) return undefined;
	return COMMAND_NAME_RE.test(parsed.name) ? parsed.name : undefined;
}

/** The message shown for a command nothing could handle. Carries the name, never the arguments. */
export function unknownSlashCommandMessage(name: string): string {
	return (
		`Unknown command "/${name}". Nothing handled it, so it was not sent to the model. ` +
		`Type / to see the commands this build has, or drop the leading slash to send it as a message.`
	);
}

/** Long option names whose value is, or can carry, a credential. Deliberately over-broad. This list gates whether a submitted slash command may */
const CREDENTIAL_OPTION_NAMES = [
	"access-token",
	"api-key",
	"apikey",
	"auth",
	"auth-token",
	"authorization",
	"authtoken",
	"bearer",
	"client-secret",
	"credential",
	"credentials",
	"header",
	"headers",
	"key",
	"key-file",
	"keyfile",
	"pass",
	"passwd",
	"password",
	"private-key",
	"refresh-token",
	"secret",
	"session-token",
	"token",
] as const;

/** Single-letter spellings that conventionally carry a credential (`-t` token, `-H` header). Matched case-sensitively and kept deliberately short: `h` is help */
const CREDENTIAL_SHORT_OPTION_NAMES = ["t", "H"] as const;

/** Matches a credential-bearing name in every spelling an argument tail can carry it in: the plain word the slash grammars now use (`token VALUE`, `key PATH`), */
const CREDENTIAL_LONG_OPTION_RE = new RegExp(`(?:^|\\s)-*(?:${CREDENTIAL_OPTION_NAMES.join("|")})(?:[\\s=]|$)`, "i");

const CREDENTIAL_SHORT_OPTION_RE = new RegExp(`(?:^|\\s)-(?:${CREDENTIAL_SHORT_OPTION_NAMES.join("|")})(?:[\\s=]|$)`);

/** A URL carrying userinfo — `scheme://user:pass@host` — anywhere in the argument string. Not tied to an option name, so it also catches a credential inside a */
const CREDENTIAL_URL_USERINFO_RE = /\/\/[^/?#\s@]+@/;

/** A query parameter whose NAME looks like a credential (`?api_key=`, `&token=`). The name pattern is the one `redactUrlForLog` already uses to keep MCP secrets */
const CREDENTIAL_QUERY_PARAM_RE = /[?&;][^=&;\s]*(?:key|token|secret|auth|password|credential)[^=&;\s]*=/i;

/** The argument vocabulary of each command whose grammar has a SLOT for a credential: `/mcp add` carries `token <token>`, `/ssh add` carries `key <path>`. */
interface CredentialBearingGrammar {
	positionals: number;
	words: Record<string, true>;
	valueWords: Record<string, true>;
	tailWords: Record<string, true>;
}

const CREDENTIAL_BEARING_GRAMMARS: Record<string, CredentialBearingGrammar> = {
	"mcp add": {
		positionals: 1,
		words: { url: true, token: true, run: true, project: true, user: true, http: true, sse: true },
		valueWords: { url: true, token: true },
		tailWords: { run: true },
	},
	"ssh add": {
		positionals: 2,
		words: { user: true, key: true, desc: true, compat: true },
		valueWords: { user: true, key: true, desc: true },
		tailWords: {},
	},
};

/** Whether a credential-bearing command's argument tail is a shape its grammar reads. Membership goes through `Object.hasOwn` because the tokens are operator */
function isRecognizedCredentialBearingTail(grammar: CredentialBearingGrammar, tokens: string[]): boolean {
	let index = grammar.positionals;
	while (index < tokens.length) {
		const token = tokens[index]!;
		if (Object.hasOwn(grammar.tailWords, token)) return true;
		if (!Object.hasOwn(grammar.words, token) && !/^\d+$/.test(token)) return false;
		index += Object.hasOwn(grammar.valueWords, token) ? 2 : 1;
	}
	return true;
}

/** Whether a submitted slash command can carry a credential or bearer token. All callers share the canonical slash parser above, including its colon */
export function isSensitiveSlashCommand(text: string): boolean {
	const parsed = parseSlashCommand(text.trimStart());
	if (!parsed) return false;
	if (parsed.name === "secret") return true;
	if (parsed.name === "login" || parsed.name === "join") return parsed.text.length > parsed.name.length + 1;
	const { args } = parsed;
	if (!args) return false;
	if (
		CREDENTIAL_LONG_OPTION_RE.test(args) ||
		CREDENTIAL_SHORT_OPTION_RE.test(args) ||
		CREDENTIAL_URL_USERINFO_RE.test(args) ||
		CREDENTIAL_QUERY_PARAM_RE.test(args)
	) {
		return true;
	}
	const { verb, rest } = parseSubcommand(args);
	const grammar = CREDENTIAL_BEARING_GRAMMARS[`${parsed.name.toLowerCase()} ${verb}`];
	if (!grammar || !rest) return false;
	return !isRecognizedCredentialBearingTail(grammar, parseCommandArgs(rest));
}

/** Normalize text at the editor submission boundary. Chat and unrelated slash commands keep the longstanding outer trim. A */
export function normalizeSubmittedPrompt(text: string): string {
	const withoutLeadingWhitespace = text.trimStart();
	const parsed = parseSlashCommand(withoutLeadingWhitespace);
	return parsed?.name === "secret" ? withoutLeadingWhitespace : text.trim();
}

/** Mark a command as fully consumed in the ACP shape. */
export function commandConsumed(): { consumed: true } {
	return { consumed: true };
}

/** Emit a usage/error message and consume the command. */
export async function usage(text: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	await runtime.output(text);
	return commandConsumed();
}

/** Split `<verb> <rest>` on the first whitespace; lowercases `verb`. */
export function parseSubcommand(input: string): ParsedSubcommand {
	const trimmed = input.trim();
	if (!trimmed) return { verb: "", rest: "" };
	const spaceIdx = trimmed.search(/\s/);
	if (spaceIdx === -1) return { verb: trimmed.toLowerCase(), rest: "" };
	return { verb: trimmed.slice(0, spaceIdx).toLowerCase(), rest: trimmed.slice(spaceIdx + 1).trim() };
}

export { errorMessage } from "@veyyon/utils";

/** The refusal for an argument written in the option style a grammar no longer has. Slash-command arguments are plain words, so a token starting with `-` is never */
export function removedOptionMessage(token: string, replacements: Record<string, string>, usageText: string): string {
	const bare = token.replace(/^-+/, "").split("=")[0]!.toLowerCase();
	const replacement = Object.hasOwn(replacements, bare) ? replacements[bare] : undefined;
	if (replacement) return `${token} is gone: ${replacement}.\n${usageText}`;
	return `Arguments are plain words, and ${token} is not one.\n${usageText}`;
}

/** Why there is nowhere for `/mcp` to write but the active profile's `<agentDir>/mcp.json`. */
export const MCP_SCOPE_REMOVED_REPLACEMENT =
	"drop it — MCP servers are configured per profile, never per repository, because a checked-in file must not name a server Veyyon connects to, and the entry is written to your profile's mcp.json";
