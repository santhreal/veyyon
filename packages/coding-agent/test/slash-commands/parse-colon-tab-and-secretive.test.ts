/**
 * parse.test.ts already splits on the first space or colon, nulls a lone
 * slash / non-slash, and lowercases only the parseSubcommand verb.
 * unresolvedSlashCommandName path / digit / typo live in
 * an-unknown-command-is-refused-not-sent-to-the-model.test.ts.
 *
 * Remaining: TAB as a separator, colon vs space when both appear, raw `text`
 * keeping a trailing space, a leading space not being a command.
 */
import { describe, expect, it } from "bun:test";
import { parseSlashCommand } from "@veyyon/coding-agent/slash-commands/helpers/parse";

describe("parseSlashCommand separator is earliest whitespace or colon", () => {
	it("splits on a tab the same way it splits on a space", () => {
		expect(parseSlashCommand("/account\tstatus")).toEqual({
			name: "account",
			args: "status",
			text: "/account\tstatus",
		});
	});

	it("uses whichever of colon or space appears first", () => {
		expect(parseSlashCommand("/foo: bar")).toEqual({ name: "foo", args: "bar", text: "/foo: bar" });
		expect(parseSlashCommand("/foo :bar")).toEqual({ name: "foo", args: ":bar", text: "/foo :bar" });
	});

	it("does not trim a trailing space out of the raw `text`, only args via trimStart", () => {
		const parsed = parseSlashCommand("/foo bar ");
		expect(parsed).toEqual({ name: "foo", args: "bar ", text: "/foo bar " });
	});

	it("does not treat a leading space as a command (caller must trim first)", () => {
		expect(parseSlashCommand(" /account")).toBeNull();
	});
});
