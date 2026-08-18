import { describe, expect, it } from "bun:test";
import { isSensitiveSlashCommand } from "@veyyon/coding-agent/slash-commands/helpers/parse";

/**
 * THE LEAK: `isSensitiveSlashCommand` decided whether a submitted slash command
 * may become durable with the regex `/(?:^|\s)--token(?:\s|$)/`, applied only to
 * the argument tail of `/mcp add`. That regex demands whitespace or
 * end-of-string after `--token`, so the equally ordinary `=` spelling never
 * matched.
 *
 * The exact leaking input:
 *
 *     /mcp add srv --url https://example.com --token=sk-live-SECRET123
 *
 * The predicate returned `false` for that line, so `shouldSkipHistory` let it
 * into recallable editor history verbatim and `createSessionTeardown` wrote those
 * same bytes to the resume draft sidecar on disk, where
 * `test/session-manager/draft.test.ts` now measures them. The space form
 * `--token sk-live-SECRET123` was suppressed correctly, so the difference between
 * a leak and no leak was one keystroke.
 *
 * The fix classifies both spellings for a deliberately over-broad set of
 * credential-bearing option names, on the arguments of ANY slash command, plus
 * credential material that sits behind no option name at all.
 *
 * The grammars then became PLAIN WORDS (`token sk-live-…`, not `--token …`), which
 * would have reopened the same hole from the other side: a matcher keyed to a dash
 * prefix sees nothing in `/mcp add srv url http://x token sk-live-SECRET123`. So
 * the dash prefix is optional now, and a second, fail-closed test was added for the
 * two grammars that HAVE a credential slot: their tail must be a shape the grammar
 * reads, or the command is treated as secret-bearing. A name list is an allowlist
 * and an allowlist cannot see a typo.
 *
 * This suite pins the classification: every option name in the plain-word and both
 * dashed spellings, quoted and unquoted, a negative control proving the OLD regex
 * really missed the `=` form, the fail-closed tail, and the benign commands that
 * must stay recallable. The durable on-disk half lives with the draft suite that
 * owns that artifact.
 *
 * WHAT IT DOES NOT CATCH: a secret typed into a POSITIONAL slot — `/mcp add
 * sk-live-SECRET123` names a server after a token — because position 1 is a name
 * whatever it spells, and there is no way to tell a server name from a secret.
 */

/**
 * The historical regex, verbatim. A negative control: if this matched the `=`
 * form, the assertions below would pass vacuously and prove nothing was fixed.
 */
const PRE_FIX_TOKEN_RE = /(?:^|\s)--token(?:\s|$)/;

/**
 * Every long option name the predicate must treat as credential-bearing by NAME
 * alone. `url` is intentionally absent: a URL carries a credential in its
 * userinfo or query string rather than by being a URL, so it is classified on
 * content below and the plain `/mcp add srv --url http://x` stays recallable.
 */
const CREDENTIAL_OPTIONS = [
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
];

const SECRET_BYTES = "sk-live-SECRET123";

describe("credential-bearing slash commands never become durable", () => {
	it("the pre-fix regex really did miss the equals spelling (negative control)", () => {
		expect(PRE_FIX_TOKEN_RE.test(`srv --url https://example.com --token ${SECRET_BYTES}`)).toBe(true);
		expect(PRE_FIX_TOKEN_RE.test(`srv --url https://example.com --token=${SECRET_BYTES}`)).toBe(false);
		// ...and the current predicate closes exactly that gap.
		expect(isSensitiveSlashCommand(`/mcp add srv --url https://example.com --token=${SECRET_BYTES}`)).toBe(true);
	});

	it.each(CREDENTIAL_OPTIONS)("classifies %s as a plain word and in both dashed spellings", option => {
		for (const args of [
			// The spelling the grammars actually have now. A matcher keyed to the dash
			// prefix reads this line as ordinary text and sends the secret to history.
			`${option} ${SECRET_BYTES}`,
			`${option}=${SECRET_BYTES}`,
			`${option} "${SECRET_BYTES}"`,
			`--${option} ${SECRET_BYTES}`,
			`--${option}=${SECRET_BYTES}`,
			`--${option} "${SECRET_BYTES}"`,
			`--${option}="${SECRET_BYTES}"`,
			`--${option}='${SECRET_BYTES}'`,
			// A bare trailing name: the value is still being typed, and the next
			// keystroke would make it durable.
			option,
			`--${option}`,
		]) {
			const command = `/mcp add srv ${args}`;
			expect(isSensitiveSlashCommand(command), command).toBe(true);
		}
	});

	it("classifies an uppercase spelling, so TOKEN and --Token cannot slip past", () => {
		expect(isSensitiveSlashCommand(`/mcp add srv --Token=${SECRET_BYTES}`)).toBe(true);
		expect(isSensitiveSlashCommand(`/mcp add srv --PASSWORD ${SECRET_BYTES}`)).toBe(true);
		expect(isSensitiveSlashCommand(`/mcp add srv TOKEN ${SECRET_BYTES}`)).toBe(true);
	});

	it("classifies the short credential spellings -t and -H", () => {
		expect(isSensitiveSlashCommand(`/mcp add srv -t ${SECRET_BYTES}`)).toBe(true);
		expect(isSensitiveSlashCommand(`/mcp add srv -t=${SECRET_BYTES}`)).toBe(true);
		expect(isSensitiveSlashCommand(`/mcp add srv -H "Authorization: Bearer ${SECRET_BYTES}"`)).toBe(true);
	});

	it("scans every command name, not just /mcp add", () => {
		// The old predicate hard-coded `name === "mcp" && verb === "add"`.
		expect(isSensitiveSlashCommand("/ssh add box h key ~/.ssh/id_ed25519")).toBe(true);
		expect(isSensitiveSlashCommand("/ssh add box --host h --key ~/.ssh/id_ed25519")).toBe(true);
		expect(isSensitiveSlashCommand(`/mcp remove srv token=${SECRET_BYTES}`)).toBe(true);
		expect(isSensitiveSlashCommand(`/mcp remove srv --token=${SECRET_BYTES}`)).toBe(true);
		expect(isSensitiveSlashCommand(`/somefuturecommand password ${SECRET_BYTES}`)).toBe(true);
		expect(isSensitiveSlashCommand(`/somefuturecommand --password=${SECRET_BYTES}`)).toBe(true);
		// The colon separator is the same parse, so it must classify identically.
		expect(isSensitiveSlashCommand(`/mcp:add srv token ${SECRET_BYTES}`)).toBe(true);
	});

	/**
	 * The fail-closed half. A name list cannot see a typo, and it cannot see a
	 * secret pasted where a grammar word belongs, so a `/mcp add` or `/ssh add`
	 * whose tail is not a shape the grammar reads is treated as secret-bearing.
	 * Every one of these is also REFUSED by the parser, so nothing recallable is
	 * lost: the command never ran.
	 */
	it.each([
		// A misspelled keyword: the value is a live token and no name matches.
		`/mcp add srv url http://x tokn ${SECRET_BYTES}`,
		`/mcp add srv url http://x TOKEM ${SECRET_BYTES}`,
		// A secret pasted with no keyword at all.
		`/mcp add srv url http://x ${SECRET_BYTES}`,
		// The dashed spellings the grammar no longer has, on a command that can
		// carry a credential: unrecognised, so unrecallable.
		"/mcp add srv --url http://x",
		"/mcp add srv --scope project --transport http",
		"/ssh add box --host h --user root --port 22",
		`/ssh add box h keyfile ${SECRET_BYTES}`,
		`/ssh add box h passphrase ${SECRET_BYTES}`,
	])("fails closed on %p, whose tail is not a shape the grammar reads", command => {
		expect(isSensitiveSlashCommand(command), command).toBe(true);
	});

	it("classifies credential material carried in a URL, whatever argument holds it", () => {
		// Userinfo in the endpoint. The URL scan is independent of the grammar, so the
		// plain-word form and both dashed forms must all classify the same.
		expect(isSensitiveSlashCommand(`/mcp add srv url https://admin:${SECRET_BYTES}@example.com/mcp`)).toBe(true);
		expect(isSensitiveSlashCommand(`/mcp add srv --url https://admin:${SECRET_BYTES}@example.com/mcp`)).toBe(true);
		expect(isSensitiveSlashCommand(`/mcp add srv --url=https://admin:${SECRET_BYTES}@example.com/mcp`)).toBe(true);
		// Secret-shaped query parameter, the shape `redactUrlForLog` already redacts.
		expect(isSensitiveSlashCommand(`/mcp add srv url https://example.com/mcp?api_key=${SECRET_BYTES}`)).toBe(true);
		expect(isSensitiveSlashCommand(`/mcp add srv url https://example.com/mcp?x=1&token=${SECRET_BYTES}`)).toBe(true);
		expect(isSensitiveSlashCommand(`/mcp add srv url https://example.com/mcp?authToken=${SECRET_BYTES}`)).toBe(true);
		// Behind no keyword at all: a stdio server's trailing command, which `run`
		// hands to the child process whole.
		expect(isSensitiveSlashCommand(`/mcp add srv run npx server --endpoint https://u:${SECRET_BYTES}@h/x`)).toBe(
			true,
		);
		expect(isSensitiveSlashCommand(`/mcp add srv -- npx server --endpoint https://u:${SECRET_BYTES}@h/x`)).toBe(true);
	});

	it("keeps classifying every /secret shape and an argument-bearing /login or /join", () => {
		expect(isSensitiveSlashCommand("/secret")).toBe(true);
		expect(isSensitiveSlashCommand("/secret list")).toBe(true);
		expect(isSensitiveSlashCommand("/login anthropic")).toBe(true);
		expect(isSensitiveSlashCommand("/join https://example.com/abc")).toBe(true);
		expect(isSensitiveSlashCommand("/login")).toBe(false);
	});

	it("leaves ordinary commands recallable, so the predicate did not simply say yes to everything", () => {
		for (const command of [
			"/mcp list",
			"/mcp test srv",
			// The plain-word grammars, in full, carrying no credential.
			"/mcp add srv http",
			"/mcp add srv url http://x",
			"/mcp add myserver url http://x project",
			"/mcp add srv sse url https://example.com/mcp",
			"/mcp add srv run npx some-server",
			"/mcp smithery-search filesystem 5 semantic",
			"/mcp remove srv user",
			"/ssh add box h",
			"/ssh add box h user root 22",
			"/ssh add box h 2222 compat",
			"/stats 8080",
			// `-p` is the /stats port and `-h` is help: neither may be swept up, and
			// `/stats` has no credential slot, so a stale spelling stays recallable.
			"/stats -p 8080",
			"/stats --port=8080",
			"/mcp -h",
			// A URL with no userinfo and no secret-shaped query parameter is not a
			// credential, and this is the most common /mcp add form.
			"/mcp add srv url https://example.com/mcp?version=2",
			// Prefix collisions on both sides of the boundary guards, on commands with
			// no credential slot so the name matcher alone answers.
			"/mcp smithery-search tokenizer",
			"/mcp test keyspace",
			"/mcp smithery-search urlencode",
			"/mcp smithery-search passage",
			"/secretary add meeting",
			"/hotkeys",
			"not a slash command at all",
		]) {
			expect(isSensitiveSlashCommand(command), command).toBe(false);
		}
	});
});
