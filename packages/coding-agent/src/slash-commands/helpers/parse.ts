import { parseCommandArgs } from "../../utils/command-args";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";

export interface ParsedSubcommand {
	verb: string;
	rest: string;
}

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

const COMMAND_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function unresolvedSlashCommandName(text: string): string | undefined {
	const parsed = parseSlashCommand(text);
	if (!parsed) return undefined;
	return COMMAND_NAME_RE.test(parsed.name) ? parsed.name : undefined;
}

export function unknownSlashCommandMessage(name: string): string {
	return (
		`Unknown command "/${name}". Nothing handled it, so it was not sent to the model. ` +
		`Type / to see the commands this build has, or drop the leading slash to send it as a message.`
	);
}

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

const CREDENTIAL_SHORT_OPTION_NAMES = ["t", "H"] as const;

const CREDENTIAL_LONG_OPTION_RE = new RegExp(`(?:^|\\s)-*(?:${CREDENTIAL_OPTION_NAMES.join("|")})(?:[\\s=]|$)`, "i");

const CREDENTIAL_SHORT_OPTION_RE = new RegExp(`(?:^|\\s)-(?:${CREDENTIAL_SHORT_OPTION_NAMES.join("|")})(?:[\\s=]|$)`);

const CREDENTIAL_URL_USERINFO_RE = /\/\/[^/?#\s@]+@/;

const CREDENTIAL_QUERY_PARAM_RE = /[?&;][^=&;\s]*(?:key|token|secret|auth|password|credential)[^=&;\s]*=/i;

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

export function normalizeSubmittedPrompt(text: string): string {
	const withoutLeadingWhitespace = text.trimStart();
	const parsed = parseSlashCommand(withoutLeadingWhitespace);
	return parsed?.name === "secret" ? withoutLeadingWhitespace : text.trim();
}

export function commandConsumed(): { consumed: true } {
	return { consumed: true };
}

export async function usage(text: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	await runtime.output(text);
	return commandConsumed();
}

export function parseSubcommand(input: string): ParsedSubcommand {
	const trimmed = input.trim();
	if (!trimmed) return { verb: "", rest: "" };
	const spaceIdx = trimmed.search(/\s/);
	if (spaceIdx === -1) return { verb: trimmed.toLowerCase(), rest: "" };
	return { verb: trimmed.slice(0, spaceIdx).toLowerCase(), rest: trimmed.slice(spaceIdx + 1).trim() };
}

export { errorMessage } from "@veyyon/utils";

export function removedOptionMessage(token: string, replacements: Record<string, string>, usageText: string): string {
	const bare = token.replace(/^-+/, "").split("=")[0]!.toLowerCase();
	const replacement = Object.hasOwn(replacements, bare) ? replacements[bare] : undefined;
	if (replacement) return `${token} is gone: ${replacement}.\n${usageText}`;
	return `Arguments are plain words, and ${token} is not one.\n${usageText}`;
}

export const MCP_SCOPE_REMOVED_REPLACEMENT =
	"drop it — MCP servers are configured per profile, never per repository, because a checked-in file must not name a server Veyyon connects to, and the entry is written to your profile's mcp.json";
