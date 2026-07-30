import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";

export interface ParsedSubcommand {
	verb: string;
	rest: string;
}

export type ConfigScope = "user" | "project";

export interface NamedScopeArgs {
	name?: string;
	scope: ConfigScope;
	error?: string;
}

/**
 * Parse a slash-invocation string into `name`/`args`.
 *
 * The separator is the earliest whitespace or `:` character so that both
 * `/foo bar` and `/foo:bar` map to `{ name: "foo", args: "bar" }`.
 */
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

/**
 * What a slash COMMAND may be called, as opposed to a path that merely starts with `/`.
 *
 * A leading slash is ambiguous: `/etc/hosts is broken` is an ordinary message about a file, while
 * `/secret list` is a command. The separator is what distinguishes them. A command name is a single
 * segment of letters, digits, underscores and hyphens beginning with a letter, so anything
 * containing a `/` is a path and anything beginning with a digit is prose.
 */
const COMMAND_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * The name of a command-shaped slash invocation that nothing was able to handle.
 *
 * Called after every resolver has had its turn (builtins, extension commands, custom commands,
 * file-based commands, prompt templates). A remaining command-shaped `/name` is a command the user
 * meant and this build does not have: a typo, a command from a newer version, or one belonging to an
 * extension that failed to load. Sending it to the model instead is the failure this exists to
 * prevent, and it is not hypothetical: `/secret list` typed into a build without that command was
 * forwarded as prose, and the model went looking through the filesystem for secrets files.
 *
 * RETURNS THE NAME ONLY, NEVER THE ARGUMENTS. A mistyped `/secrt add DB_PASSWORD hunter2` must
 * produce an error naming `secrt` and nothing else, because the argument tail of a miss on a
 * credential command is a credential. See {@link isSensitiveSlashCommand}.
 */
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

/**
 * Long option names whose value is, or can carry, a credential.
 *
 * Deliberately over-broad. This list gates whether a submitted slash command may
 * become recallable editor history or a resumable draft on disk, so an option
 * that MIGHT carry a secret belongs here: a false positive costs one line of
 * arrow-up recall, a false negative writes a live credential to durable storage.
 *
 * `key` covers `/ssh add --key <path>`. `url` is deliberately absent: an endpoint
 * carries a credential in its userinfo or query string rather than by virtue of
 * being a URL, so it is matched structurally below instead — that keeps the plain
 * `/mcp add srv --url http://x` recallable while still catching a real secret.
 */
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

/**
 * Single-letter spellings that conventionally carry a credential (`-t` token,
 * `-H` header). Matched case-sensitively and kept deliberately short: `-h` is
 * help and `-p` is the port of `/stats -p <port>`, so neither may join this set
 * without silently making a common command unrecallable.
 */
const CREDENTIAL_SHORT_OPTION_NAMES = ["t", "H"] as const;

/**
 * Matches a credential-bearing option in either spelling: `--token VALUE`,
 * `--token=VALUE`, `--token="VALUE"`, or a bare trailing `--token`. The trailing
 * `[\s=]|$` guard is what keeps `--tokenizer` out, and the leading `^|\s` guard
 * is what keeps `--key` from matching inside `--api-key`.
 *
 * Long names are case-insensitive so `--Token` cannot slip past; short names are
 * matched case-sensitively in a separate alternation so `-t` does not drag `-T`
 * and, more importantly, `-H` does not drag `-h`.
 */
const CREDENTIAL_LONG_OPTION_RE = new RegExp(`(?:^|\\s)--(?:${CREDENTIAL_OPTION_NAMES.join("|")})(?:[\\s=]|$)`, "i");

const CREDENTIAL_SHORT_OPTION_RE = new RegExp(`(?:^|\\s)-(?:${CREDENTIAL_SHORT_OPTION_NAMES.join("|")})(?:[\\s=]|$)`);

/**
 * A URL carrying userinfo — `scheme://user:pass@host` — anywhere in the argument
 * string. Not tied to an option name, so it also catches a credential inside a
 * stdio server's `-- <command...>` tail.
 */
const CREDENTIAL_URL_USERINFO_RE = /\/\/[^/?#\s@]+@/;

/**
 * A query parameter whose NAME looks like a credential (`?api_key=`, `&token=`).
 * The name pattern is the one `redactUrlForLog` already uses to keep MCP secrets
 * out of the log file, so the durable-history gate and the logger agree on what a
 * secret-bearing URL is.
 */
const CREDENTIAL_QUERY_PARAM_RE = /[?&;][^=&;\s]*(?:key|token|secret|auth|password|credential)[^=&;\s]*=/i;

/**
 * Whether a submitted slash command can carry a credential or bearer token.
 *
 * All callers share the canonical slash parser above, including its colon
 * separator. This deliberately classifies every `/secret` shape — help,
 * management, malformed and future syntax — because a parser failure must not
 * turn candidate credential bytes into durable history or a teardown draft.
 *
 * Beyond those whole-command cases, the arguments of ANY slash command are
 * scanned for a credential-bearing option, in both the space and the equals
 * spelling, plus credential material that sits in no named option at all (URL
 * userinfo, a secret-shaped query parameter). Scanning every command rather than
 * an allowlist of `(command, verb)` pairs is deliberate: the previous version only
 * knew about `/mcp add --token`, so `/mcp add x --url u --token=sk-live-...` wrote
 * the live token straight to history, and every future command taking
 * `--password` would have repeated the mistake.
 */
export function isSensitiveSlashCommand(text: string): boolean {
	const parsed = parseSlashCommand(text.trimStart());
	if (!parsed) return false;
	if (parsed.name === "secret") return true;
	if (parsed.name === "login" || parsed.name === "join") return parsed.text.length > parsed.name.length + 1;
	const { args } = parsed;
	if (!args) return false;
	return (
		CREDENTIAL_LONG_OPTION_RE.test(args) ||
		CREDENTIAL_SHORT_OPTION_RE.test(args) ||
		CREDENTIAL_URL_USERINFO_RE.test(args) ||
		CREDENTIAL_QUERY_PARAM_RE.test(args)
	);
}

/**
 * Normalize text at the editor submission boundary.
 *
 * Chat and unrelated slash commands keep the longstanding outer trim. A
 * canonical `/secret` keeps every trailing code unit because its raw suffix may
 * be an inline credential; only whitespace before the slash is navigation
 * chrome rather than credential data. Prefix lookalikes such as `/secretive`
 * remain ordinary chat and therefore remain trimmed.
 */
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

/**
 * Parse `<name?> [--scope project|user]`-style argument strings used by
 * remove/rm-style subcommands. `name` is optional so callers can surface
 * "name required" diagnostics with their own messaging.
 */
export function parseNamedScopeArgs(rest: string, invalidScopeMessage: string): NamedScopeArgs {
	const tokens = rest.split(/\s+/).filter(Boolean);
	let name: string | undefined;
	let scope: ConfigScope = "project";
	let i = 0;
	if (tokens.length > 0 && !tokens[0]!.startsWith("-")) {
		name = tokens[0];
		i = 1;
	}
	while (i < tokens.length) {
		const token = tokens[i]!;
		if (token !== "--scope") return { scope, error: `Unknown option: ${token}` };
		const value = tokens[i + 1];
		if (!value || (value !== "project" && value !== "user")) return { scope, error: invalidScopeMessage };
		scope = value;
		i += 2;
	}
	return { name, scope };
}
