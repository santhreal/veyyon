import { parseCommandArgs } from "../../utils/command-args";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";

export interface ParsedSubcommand {
	verb: string;
	rest: string;
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
 * `key` covers `/ssh add <name> <host> key <path>`. `url` is deliberately absent:
 * an endpoint carries a credential in its userinfo or query string rather than by
 * virtue of being a URL, so it is matched structurally below instead — that keeps
 * the plain `/mcp add srv url http://x` recallable while still catching a real
 * secret.
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
 * `-H` header). Matched case-sensitively and kept deliberately short: `h` is help
 * and `p` was a port, so neither may join this set without silently making a
 * common command unrecallable.
 */
const CREDENTIAL_SHORT_OPTION_NAMES = ["t", "H"] as const;

/**
 * Matches a credential-bearing name in every spelling an argument tail can carry
 * it in: the plain word the slash grammars now use (`token VALUE`, `key PATH`),
 * and the dashed spellings that used to be the way in (a following value, an `=`
 * value, a quoted value, or the name alone at the end of the line).
 *
 * The dash prefix is OPTIONAL, and that is the point of this matcher. The
 * grammars became plain words, so a pattern that required a dash would classify
 * `/mcp add srv url https://x token sk-live-…` as safe and write the live bearer
 * token to recallable history. Dashed spellings keep matching because a
 * `run <command...>` tail carries the child process's own flags verbatim.
 *
 * The trailing `[\s=]|$` guard is what keeps `tokenizer` out, and the leading
 * `^|\s` guard is what keeps `key` from matching inside `api-key` or `monkey`.
 *
 * Long names are case-insensitive so `Token` cannot slip past; short names are
 * matched case-sensitively in a separate alternation so `-t` does not drag `-T`
 * and, more importantly, `-H` does not drag `-h`.
 */
const CREDENTIAL_LONG_OPTION_RE = new RegExp(`(?:^|\\s)-*(?:${CREDENTIAL_OPTION_NAMES.join("|")})(?:[\\s=]|$)`, "i");

const CREDENTIAL_SHORT_OPTION_RE = new RegExp(`(?:^|\\s)-(?:${CREDENTIAL_SHORT_OPTION_NAMES.join("|")})(?:[\\s=]|$)`);

/**
 * A URL carrying userinfo — `scheme://user:pass@host` — anywhere in the argument
 * string. Not tied to an option name, so it also catches a credential inside a
 * stdio server's `run <command...>` tail.
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
 * The argument vocabulary of each command whose grammar has a SLOT for a
 * credential: `/mcp add` carries `token <token>`, `/ssh add` carries `key <path>`.
 *
 * `positionals` is how many leading tokens the grammar reads by POSITION — a
 * server name, or a host name and its address — and which therefore cannot be a
 * secret typed into an option's place. `words` is every keyword and closed-set
 * word read after those; `valueWords` is the subset whose following token is
 * arbitrary text; `tailWords` hand the whole remainder to a child process.
 *
 * A tail is RECOGNISED when every token past the positionals is one of those
 * words, the value of a `valueWord`, or an integer. Anything else is data of an
 * unknown shape on a command that can carry a secret, so it is classified
 * sensitive: a value-less `token`, a misspelled `tokn sk-live-…`, and a
 * half-remembered option spelling all land here rather than in history.
 *
 * This deliberately restates the two grammars rather than importing their
 * parsers, which import this module. Drift is safe in exactly one direction and
 * this is that direction: a word added to a grammar and not added here is
 * unrecognised, so the command becomes unrecallable instead of becoming a leak.
 */
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

/**
 * Whether a credential-bearing command's argument tail is a shape its grammar
 * reads. Membership goes through `Object.hasOwn` because the tokens are operator
 * input: a plain index would answer yes to `constructor` and `toString` off the
 * prototype, which is the one direction this test may not be wrong in.
 */
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

/**
 * Whether a submitted slash command can carry a credential or bearer token.
 *
 * All callers share the canonical slash parser above, including its colon
 * separator. This deliberately classifies every `/secret` shape — help,
 * management, malformed and future syntax — because a parser failure must not
 * turn candidate credential bytes into durable history or a teardown draft.
 *
 * Beyond those whole-command cases, the arguments of ANY slash command are
 * scanned for a credential-bearing name, as a plain word and in both dashed
 * spellings, plus credential material that sits in no named argument at all (URL
 * userinfo, a secret-shaped query parameter). Scanning every command rather than
 * an allowlist of `(command, verb)` pairs is deliberate: an early version knew
 * only about the token option of `/mcp add`, so the same secret behind an `=`
 * went straight to history, and every future command taking a password would
 * have repeated the mistake.
 *
 * A command whose grammar HAS a credential slot gets one more test, and it is the
 * one that fails closed: its tail must be a shape that grammar reads. A name
 * match is an allowlist and an allowlist cannot see a typo, so anything else in
 * the tail of `/mcp add` or `/ssh add` is treated as a secret.
 */
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
 * The refusal for an argument written in the option style a grammar no longer has.
 *
 * Slash-command arguments are plain words, so a token starting with `-` is never
 * an argument, and it is REFUSED naming the plain word that replaced it. Neither
 * alternative is honest: accepting the old spelling keeps a grammar nobody can
 * see, and ignoring it writes an entry missing the very setting that was asked
 * for. `replacements` is keyed by the bare option name (`scope`, `port`), the
 * empty string keying the separator that used to introduce a command tail.
 */
export function removedOptionMessage(token: string, replacements: Record<string, string>, usageText: string): string {
	const bare = token.replace(/^-+/, "").split("=")[0]!.toLowerCase();
	const replacement = Object.hasOwn(replacements, bare) ? replacements[bare] : undefined;
	if (replacement) return `${token} is gone: ${replacement}.\n${usageText}`;
	return `Arguments are plain words, and ${token} is not one.\n${usageText}`;
}

/**
 * Why there is nowhere for `/mcp` to write but the active profile's
 * `<agentDir>/mcp.json`.
 *
 * There used to be a scope, and `project` was the DEFAULT. It wrote
 * `<cwd>/.veyyon/mcp.json` and read `<cwd>/mcp.json` and `<cwd>/.mcp.json`
 * alongside it. A repository is content the operator may not have written, so
 * nothing loads those files any more; a project-scoped write would land in a
 * file no session ever reads, and a repo-supplied entry must never become a
 * server `/mcp test` connects to.
 *
 * It lives HERE, in the module both `/mcp` surfaces already import, because the
 * TUI controller and the text handler must refuse the word with the SAME
 * sentence: two copies drift, and a test pinning one of them stays green while
 * the other says something else. Phrased as a replacement clause because it is
 * delivered by {@link removedOptionMessage}, which names the word that was
 * written.
 */
export const MCP_SCOPE_REMOVED_REPLACEMENT =
	"drop it — MCP servers are configured per profile, never per repository, because a checked-in file must not name a server Veyyon connects to, and the entry is written to your profile's mcp.json";
