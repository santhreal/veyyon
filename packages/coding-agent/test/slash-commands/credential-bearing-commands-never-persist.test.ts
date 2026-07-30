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
 * credential material that sits behind no option name at all. This suite pins the
 * classification: every option in both spellings, quoted and unquoted, a negative
 * control proving the OLD regex really missed the `=` form, and the benign
 * commands that must stay recallable. The durable on-disk half lives with the
 * draft suite that owns that artifact.
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

	it.each(CREDENTIAL_OPTIONS)("classifies --%s in both spellings, quoted and unquoted", option => {
		for (const args of [
			`--${option} ${SECRET_BYTES}`,
			`--${option}=${SECRET_BYTES}`,
			`--${option} "${SECRET_BYTES}"`,
			`--${option}="${SECRET_BYTES}"`,
			`--${option}='${SECRET_BYTES}'`,
			// A bare trailing flag: the value is still being typed, and the next
			// keystroke would make it durable.
			`--${option}`,
		]) {
			const command = `/mcp add srv ${args}`;
			expect(isSensitiveSlashCommand(command), command).toBe(true);
		}
	});

	it("classifies an uppercase long spelling, so --Token cannot slip past", () => {
		expect(isSensitiveSlashCommand(`/mcp add srv --Token=${SECRET_BYTES}`)).toBe(true);
		expect(isSensitiveSlashCommand(`/mcp add srv --PASSWORD ${SECRET_BYTES}`)).toBe(true);
	});

	it("classifies the short credential spellings -t and -H", () => {
		expect(isSensitiveSlashCommand(`/mcp add srv -t ${SECRET_BYTES}`)).toBe(true);
		expect(isSensitiveSlashCommand(`/mcp add srv -t=${SECRET_BYTES}`)).toBe(true);
		expect(isSensitiveSlashCommand(`/mcp add srv -H "Authorization: Bearer ${SECRET_BYTES}"`)).toBe(true);
	});

	it("scans every command name, not just /mcp add", () => {
		// The old predicate hard-coded `name === "mcp" && verb === "add"`.
		expect(isSensitiveSlashCommand("/ssh add box --host h --key ~/.ssh/id_ed25519")).toBe(true);
		expect(isSensitiveSlashCommand(`/mcp remove srv --token=${SECRET_BYTES}`)).toBe(true);
		expect(isSensitiveSlashCommand(`/somefuturecommand --password=${SECRET_BYTES}`)).toBe(true);
		// The colon separator is the same parse, so it must classify identically.
		expect(isSensitiveSlashCommand(`/mcp:add srv --token=${SECRET_BYTES}`)).toBe(true);
	});

	it("classifies credential material carried in a URL, whatever option holds it", () => {
		// Userinfo in the endpoint.
		expect(isSensitiveSlashCommand(`/mcp add srv --url https://admin:${SECRET_BYTES}@example.com/mcp`)).toBe(true);
		expect(isSensitiveSlashCommand(`/mcp add srv --url=https://admin:${SECRET_BYTES}@example.com/mcp`)).toBe(true);
		// Secret-shaped query parameter, the shape `redactUrlForLog` already redacts.
		expect(isSensitiveSlashCommand(`/mcp add srv --url https://example.com/mcp?api_key=${SECRET_BYTES}`)).toBe(true);
		expect(isSensitiveSlashCommand(`/mcp add srv --url https://example.com/mcp?x=1&token=${SECRET_BYTES}`)).toBe(
			true,
		);
		expect(isSensitiveSlashCommand(`/mcp add srv --url https://example.com/mcp?authToken=${SECRET_BYTES}`)).toBe(
			true,
		);
		// Behind no known option at all: a stdio server's trailing command.
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
			"/mcp add srv --scope project --transport http",
			"/mcp smithery-search filesystem --limit 5 --semantic",
			"/ssh add box --host h --user root --port 22",
			// `-p` is the /stats port and `-h` is help: neither may be swept up.
			"/stats -p 8080",
			"/stats --port=8080",
			"/mcp -h",
			// A URL with no userinfo and no secret-shaped query parameter is not a
			// credential, and this is the most common /mcp add form.
			"/mcp add srv --url http://x",
			"/mcp add myserver --url http://x",
			"/mcp add srv --url https://example.com/mcp?version=2",
			// Prefix collisions on both sides of the boundary guards.
			"/mcp add srv --tokenizer fast",
			"/mcp add srv --urlencode x",
			"/mcp add srv --keyspace default",
			"/secretary add meeting",
			"/hotkeys",
			"not a slash command at all",
		]) {
			expect(isSensitiveSlashCommand(command), command).toBe(false);
		}
	});
});
