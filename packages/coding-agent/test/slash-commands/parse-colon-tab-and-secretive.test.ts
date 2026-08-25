/**
 * `parseSlashCommand` splits on the earliest whitespace OR `:`.
 *
 * Existing parse.test.ts pins unknown-command refusal. It does not pin:
 *   - TAB as the separator (composer can insert one)
 *   - colon vs space when BOTH appear (`/foo: bar` vs `/foo :bar`)
 *   - `//etc/hosts` not being a command name
 *
 * `/login` length, `/secret` trailing spaces, and `/secretive` live in
 * sensitive-url-userinfo-and-query-and-login-bare.test.ts.
 */
import { describe, expect, it } from "bun:test";
import {
	parseSlashCommand,
	parseSubcommand,
	unresolvedSlashCommandName,
} from "@veyyon/coding-agent/slash-commands/helpers/parse";

describe("parseSlashCommand separator is earliest whitespace or colon", () => {
	it("splits on a tab the same way it splits on a space", () => {
		expect(parseSlashCommand("/account\tstatus")).toEqual({
			name: "account",
			args: "status",
			text: "/account\tstatus",
		});
	});

	it("splits on a colon when there is no whitespace", () => {
		expect(parseSlashCommand("/account:status")).toEqual({
			name: "account",
			args: "status",
			text: "/account:status",
		});
	});

	it("uses the colon when it appears before the space", () => {
		expect(parseSlashCommand("/foo: bar")).toEqual({
			name: "foo",
			args: "bar",
			text: "/foo: bar",
		});
	});

	it("uses the space when it appears before the colon", () => {
		expect(parseSlashCommand("/foo :bar")).toEqual({
			name: "foo",
			args: ":bar",
			text: "/foo :bar",
		});
	});

	it("does not trim a trailing space out of the raw `text`, only args via trimStart", () => {
		const parsed = parseSlashCommand("/foo bar ");
		expect(parsed).not.toBeNull();
		expect(parsed?.name).toBe("foo");
		expect(parsed?.args).toBe("bar ");
		expect(parsed?.text).toBe("/foo bar ");
	});

	it("returns null for a lone slash", () => {
		expect(parseSlashCommand("/")).toBeNull();
	});

	it("returns null when the text does not start with slash", () => {
		expect(parseSlashCommand("account status")).toBeNull();
	});

	it("does not treat a leading space as a command (caller must trim first)", () => {
		expect(parseSlashCommand(" /account")).toBeNull();
	});
});

describe("unresolvedSlashCommandName refuses path-shaped slashes", () => {
	it("does not treat /etc/hosts as a command name", () => {
		expect(unresolvedSlashCommandName("/etc/hosts is broken")).toBeUndefined();
	});

	it("does not treat a digit-leading token as a command", () => {
		expect(unresolvedSlashCommandName("/2fa codes")).toBeUndefined();
	});

	it("does return the name of a letter-leading unknown command, never the args", () => {
		expect(unresolvedSlashCommandName("/secrt add DB_PASSWORD hunter2")).toBe("secrt");
	});
});

describe("parseSubcommand lowercases only the verb", () => {
	it("returns empty verb and rest for whitespace", () => {
		expect(parseSubcommand("   ")).toEqual({ verb: "", rest: "" });
	});

	it("lowercases a single token verb", () => {
		expect(parseSubcommand("STATUS")).toEqual({ verb: "status", rest: "" });
	});

	it("does not lowercase the rest", () => {
		expect(parseSubcommand("add DB_PASSWORD hunter2")).toEqual({
			verb: "add",
			rest: "DB_PASSWORD hunter2",
		});
	});
});
