import { describe, expect, it } from "bun:test";
import {
	commandConsumed,
	MCP_SCOPE_REMOVED_REPLACEMENT,
	parseSlashCommand,
	parseSubcommand,
	removedOptionMessage,
	usage,
} from "@veyyon/coding-agent/slash-commands/helpers/parse";
import type { SlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

/**
 * parse.ts is the front door for every slash command: it splits the raw
 * `/name args` string, splits a subcommand verb off its rest, and builds the
 * refusal every grammar hands an argument written in the option style none of
 * them has any more. These are pure string parsers with several easy-to-break
 * edge cases (the earliest-of-whitespace-or-colon separator, verb lowercasing,
 * and the dash/`=` stripping that finds the bare option name). A regression
 * silently routes a command to the wrong handler, drops arguments, or answers a
 * removed spelling with a message that names no replacement. These assert the
 * exact parsed objects and the exact error strings.
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

describe("removedOptionMessage", () => {
	const USAGE = "Usage: /thing remove <name>";

	/**
	 * The replacement map is keyed by the BARE name, so every spelling of the same
	 * option has to reduce to that key: leading dashes, one or two, and an `=value`
	 * tail. Miss any of them and the operator gets the generic refusal, which names
	 * no replacement and leaves them guessing.
	 */
	it("finds the replacement under every spelling of the same option", () => {
		const replacements = { scope: "write `project` or `user` as a plain word" };
		for (const token of ["--scope", "-scope", "--scope=user", "--SCOPE"]) {
			expect(removedOptionMessage(token, replacements, USAGE)).toBe(
				`${token} is gone: write \`project\` or \`user\` as a plain word.\n${USAGE}`,
			);
		}
	});

	/**
	 * A plain word can be a key too, which is how `/mcp` refuses `project` with the
	 * reason instead of reading it as a name or dropping it.
	 */
	it("refuses a plain word that is itself a removed spelling", () => {
		expect(removedOptionMessage("project", { project: MCP_SCOPE_REMOVED_REPLACEMENT }, USAGE)).toBe(
			`project is gone: ${MCP_SCOPE_REMOVED_REPLACEMENT}.\n${USAGE}`,
		);
	});

	/** The empty key is the bare `--` separator that used to introduce a command tail. */
	it("reads the bare separator through the empty key", () => {
		expect(removedOptionMessage("--", { "": "write `run <command...>`" }, USAGE)).toBe(
			`-- is gone: write \`run <command...>\`.\n${USAGE}`,
		);
	});

	it("falls back to naming the token when no replacement is registered", () => {
		expect(removedOptionMessage("--bogus", { scope: "x" }, USAGE)).toBe(
			`Arguments are plain words, and --bogus is not one.\n${USAGE}`,
		);
	});

	/**
	 * `Object.hasOwn`, not a truthy lookup: an inherited `toString` must not be
	 * mistaken for a registered replacement and printed as one.
	 */
	it("does not read a replacement off the prototype", () => {
		expect(removedOptionMessage("--toString", { scope: "x" }, USAGE)).toBe(
			`Arguments are plain words, and --toString is not one.\n${USAGE}`,
		);
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
