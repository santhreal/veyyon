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
 * Whether a submitted slash command can carry a credential or bearer token.
 *
 * All callers share the canonical slash parser above, including its colon
 * separator. This deliberately classifies every `/secret` shape — help,
 * management, malformed and future syntax — because a parser failure must not
 * turn candidate credential bytes into durable history or a teardown draft.
 */
export function isSensitiveSlashCommand(text: string): boolean {
	const parsed = parseSlashCommand(text.trimStart());
	if (!parsed) return false;
	if (parsed.name === "secret") return true;
	if (parsed.name === "login" || parsed.name === "join") return parsed.text.length > parsed.name.length + 1;
	if (parsed.name !== "mcp") return false;
	const { verb, rest } = parseSubcommand(parsed.args);
	return verb === "add" && /(?:^|\s)--token(?:\s|$)/.test(rest);
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
