import { describe, expect, it } from "bun:test";
import {
	commandConsumed,
	parseNamedScopeArgs,
	parseSlashCommand,
	parseSubcommand,
	usage,
} from "@veyyon/coding-agent/slash-commands/helpers/parse";
import type { SlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

/**
 * parse.ts is the front door for every slash command: it splits the raw
 * `/name args` string, splits a subcommand verb off its rest, and parses the
 * shared `<name?> [--scope project|user]` argument grammar used by remove-style
 * commands. These are pure string parsers with several easy-to-break edge cases
 * (the earliest-of-whitespace-or-colon separator, verb lowercasing, the optional
 * leading name, and the strict --scope validation). A regression silently routes a
 * command to the wrong handler, drops arguments, or accepts an invalid scope.
 * These assert the exact parsed objects and the exact error strings.
 */

describe("parseSlashCommand", () => {
	it("splits on the first whitespace and trims the args", () => {
		expect(parseSlashCommand("/foo bar")).toEqual({ name: "foo", args: "bar", text: "/foo bar" });
		expect(parseSlashCommand("/foo   spaced")).toEqual({ name: "foo", args: "spaced", text: "/foo   spaced" });
	});

	it("splits on the first colon and keeps later separators inside args", () => {
		expect(parseSlashCommand("/foo:bar baz")).toEqual({ name: "foo", args: "bar baz", text: "/foo:bar baz" });
	});

	it("returns an empty args string for a bare command", () => {
		expect(parseSlashCommand("/foo")).toEqual({ name: "foo", args: "", text: "/foo" });
	});

	it("returns null for non-slash text and a lone slash", () => {
		expect(parseSlashCommand("nope")).toBeNull();
		expect(parseSlashCommand("/")).toBeNull();
	});
});

describe("parseSubcommand", () => {
	it("splits the verb off the rest and lowercases only the verb", () => {
		expect(parseSubcommand("  Add file.txt here ")).toEqual({ verb: "add", rest: "file.txt here" });
	});

	it("lowercases a lone verb with an empty rest", () => {
		expect(parseSubcommand("LIST")).toEqual({ verb: "list", rest: "" });
	});

	it("returns empty verb and rest for blank input", () => {
		expect(parseSubcommand("   ")).toEqual({ verb: "", rest: "" });
	});
});

describe("parseNamedScopeArgs", () => {
	it("reads a leading name and an explicit scope", () => {
		expect(parseNamedScopeArgs("myname --scope user", "bad scope")).toEqual({ name: "myname", scope: "user" });
	});

	it("omits the name when the first token is a flag and defaults scope to project", () => {
		expect(parseNamedScopeArgs("--scope project", "bad scope")).toEqual({ scope: "project" });
		expect(parseNamedScopeArgs("", "bad scope")).toEqual({ scope: "project" });
	});

	it("reports an unknown option by name", () => {
		expect(parseNamedScopeArgs("foo bar", "bad scope")).toEqual({ scope: "project", error: "Unknown option: bar" });
	});

	it("uses the caller's message for an invalid or missing scope value", () => {
		expect(parseNamedScopeArgs("foo --scope nope", "bad scope")).toEqual({ scope: "project", error: "bad scope" });
		expect(parseNamedScopeArgs("foo --scope", "bad scope")).toEqual({ scope: "project", error: "bad scope" });
	});
});

describe("commandConsumed and usage", () => {
	it("marks a command consumed in the ACP shape", () => {
		expect(commandConsumed()).toEqual({ consumed: true });
	});

	it("usage emits the message through the runtime and consumes the command", async () => {
		const emitted: string[] = [];
		const runtime = { output: async (text: string) => void emitted.push(text) } as unknown as SlashCommandRuntime;
		const result = await usage("try /foo <arg>", runtime);
		expect(emitted).toEqual(["try /foo <arg>"]);
		expect(result).toEqual({ consumed: true });
	});
});
