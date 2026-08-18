/**
 * A word that used to be an option is refused with the sentence naming what
 * replaced it, whether it is written with dashes or as a plain word.
 *
 * THE DEFECT THIS CLOSES. Every command below carries a map of the option
 * spellings it no longer has, keyed by bare name, and `removedOptionMessage`
 * turns a key into "`--scope` is gone: <replacement>." Each parser reached that
 * map only for a token starting with `-`, so the dashed spelling got the reason
 * and the plain spelling got a bare `Unknown argument: scope`. Both refuse, so
 * nothing was silently written — but the operator who typed the word the old
 * grammar taught was told only that it was not understood, and never which word
 * replaced it. `/mcp remove` had a second version of the same bug: it named
 * `project` and `user` in an `extra === "project" || extra === "user"`
 * condition sitting beside a map that already listed both, so a key added to the
 * map would keep its dashed refusal and silently lose its plain one.
 *
 * THE CLASS, not the incident: the keys are read from the live maps at run time,
 * so an option removed from any of these commands later is swept without anyone
 * listing it here. The only thing written down is which keys are LIVE SYNTAX on
 * their command — `user` is both a spelling `/ssh add` used to have and the
 * keyword it has now — and each exception set is pinned by exact equality, so a
 * new keyword that collides with a removed option turns this suite red until
 * someone records the collision.
 *
 * WHAT THIS DOES NOT CATCH. It sweeps the text/ACP handlers only. The TUI
 * controllers (`mcp-command-controller.ts`, `ssh-command-controller.ts`) have
 * their own argument readers, and a plain removed word there is covered by
 * `mcp-command-ignores-repo-config.test.ts` for the scope words alone — no sweep
 * enumerates the other keys on that surface. It also asserts the SENTENCE, not
 * the effect: a refusal that carried the right words while still writing a file
 * would pass here and fail that suite.
 */
import { describe, expect, test } from "bun:test";
import {
	handleMcpAcp,
	MCP_ADD_REMOVED_OPTIONS,
	MCP_REMOVE_REMOVED_OPTIONS,
	MCP_SEARCH_REMOVED_OPTIONS,
} from "@veyyon/coding-agent/slash-commands/helpers/mcp";
import { parseSlashCommand } from "@veyyon/coding-agent/slash-commands/helpers/parse";
import {
	handleSshAcp,
	SSH_ADD_REMOVED_OPTIONS,
	SSH_REMOVE_REMOVED_OPTIONS,
} from "@veyyon/coding-agent/slash-commands/helpers/ssh";
import type {
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
} from "@veyyon/coding-agent/slash-commands/types";

type Handler = (command: ParsedSlashCommand, runtime: SlashCommandRuntime) => Promise<SlashCommandResult>;

/**
 * One surface, driven the way `builtin-registry` drives it. `cwd` is a directory
 * that does not exist, which is safe because every line this file sends is
 * refused during parsing and never reaches a reader or a writer — and if one
 * ever did reach a writer, it would fail loudly here rather than touch the
 * developer's real profile.
 */
function surface(handler: Handler) {
	return async (text: string): Promise<string> => {
		const output: string[] = [];
		const runtime = {
			cwd: "/nonexistent-veyyon-test-cwd",
			output: (line: string) => {
				output.push(line);
			},
			session: { modelRegistry: { authStorage: undefined } },
		} as unknown as SlashCommandRuntime;
		const command = parseSlashCommand(text);
		if (!command) throw new Error(`${text} must parse as a slash command`);
		await handler(command, runtime);
		return output.join("\n");
	};
}

const runMcp = surface(handleMcpAcp as Handler);
const runSsh = surface(handleSshAcp as Handler);

/**
 * Each command that owns a removed-option map, with the position a trailing word
 * lands in and the keys that are live syntax there rather than removed spellings.
 *
 * `line` puts the word where the grammar reads a trailing word, after enough
 * leading positionals to get past the ones read by position — otherwise the word
 * would be consumed as the server name and the test would be asserting nothing.
 */
interface SweptCommand {
	/** How the command is spelled, for the test name. */
	name: string;
	/** The removed-option map this command owns: the variant space, read at run time. */
	map: Record<string, string>;
	/** The surface that reads it. A thunk so the table can be declared above them. */
	run: () => (text: string) => Promise<string>;
	/** Where a trailing word lands, past the slots read by position. */
	line: (word: string) => string;
	/** Keys that are live syntax here, so their plain spelling is not a refusal. */
	liveSyntax: readonly string[];
}

const COMMANDS: readonly SweptCommand[] = [
	{
		name: "/mcp add",
		map: MCP_ADD_REMOVED_OPTIONS,
		run: () => runMcp,
		line: (word: string) => `/mcp add srv ${word}`,
		// `url` and `token` are the keywords that replaced `--url` and `--token`,
		// so their plain spelling is syntax. The empty key is the old `--`
		// separator and has no plain spelling at all: a word cannot be empty.
		liveSyntax: ["", "token", "url"],
	},
	{
		name: "/mcp remove",
		map: MCP_REMOVE_REMOVED_OPTIONS,
		run: () => runMcp,
		line: (word: string) => `/mcp remove srv ${word}`,
		liveSyntax: [],
	},
	{
		name: "/ssh add",
		map: SSH_ADD_REMOVED_OPTIONS,
		run: () => runSsh,
		line: (word: string) => `/ssh add box example.com ${word}`,
		// `user` and `key` are the keywords that replaced `--user` and `--key`.
		liveSyntax: ["key", "user"],
	},
	{
		name: "/ssh remove",
		map: SSH_REMOVE_REMOVED_OPTIONS,
		run: () => runSsh,
		line: (word: string) => `/ssh remove box ${word}`,
		liveSyntax: [],
	},
];

describe("a removed option spelling and its plain word give the same reason", () => {
	// The maps are the variant space, and it is read here rather than restated, so
	// an option removed later is swept without an edit to this file.
	test("every command's map has keys to sweep", () => {
		for (const command of COMMANDS) {
			expect(Object.keys(command.map).length).toBeGreaterThan(0);
		}
	});

	for (const command of COMMANDS) {
		describe(command.name, () => {
			// PINNED BY EXACT EQUALITY. A new keyword that happens to share a name
			// with a removed option fails here first, which is the point: it is a
			// decision about the grammar and not a detail to absorb silently.
			test("its live-syntax keys are exactly the ones recorded", () => {
				const declared = Object.keys(command.map).filter(key => command.liveSyntax.includes(key));
				expect(declared.sort()).toEqual([...command.liveSyntax].sort());
			});

			const removedKeys = Object.keys(command.map).filter(key => !command.liveSyntax.includes(key));

			for (const key of removedKeys) {
				test(`--${key} is refused with its replacement`, async () => {
					const output = await command.run()(command.line(`--${key}`));
					expect(output).toContain(`--${key} is gone:`);
					expect(output).toContain(command.map[key]!);
				});

				test(`a plain ${key} is refused with the same replacement`, async () => {
					const output = await command.run()(command.line(key));
					expect(output).toContain(command.map[key]!);
					// Not the generic fallback. This is the assertion that was red
					// before the fix: the plain word reached `Unknown argument`.
					expect(output).not.toContain(`Unknown argument: ${key}`);
				});
			}
		});
	}

	// A word that never was an option keeps the plain, short refusal. Routing
	// every unrecognised word through the removed-option message would tell an
	// operator who mistyped a hostname that arguments are plain words, which is
	// true and useless.
	//
	// SWEPT PER COMMAND, because the first version of this asserted it for the two
	// `remove` commands only, and the gate caught it: routing every unrecognised
	// word on `/ssh add` through the removed-option message left the suite green.
	// One fallback per command reader is one place this can be got wrong.
	describe("a word that was never an option is still just unknown", () => {
		// Not a key in any map and not live syntax on any of these commands: it has a
		// hyphen so no name-shaped slot claims it, and it is not digits, so `/ssh add`
		// cannot read it as a port.
		const NEVER = "zzz-not-an-option";

		for (const command of COMMANDS) {
			test(command.name, async () => {
				expect(Object.hasOwn(command.map, NEVER)).toBe(false);
				const output = await command.run()(command.line(NEVER));
				expect(output).toContain(`Unknown argument: ${NEVER}`);
			});
		}
	});

	// `/mcp smithery-search` is deliberately absent from the sweep: its trailing
	// words are SEARCH TERMS, arbitrary text with no closed set, so a plain
	// `project` there is a keyword to search for and must not be refused. Only the
	// dashed spellings are gone, and those are asserted directly.
	describe("/mcp smithery-search keeps plain words as search terms", () => {
		for (const key of Object.keys(MCP_SEARCH_REMOVED_OPTIONS)) {
			test(`--${key} is refused`, async () => {
				const output = await runMcp(`/mcp smithery-search redis --${key}`);
				expect(output).toContain(`--${key} is gone:`);
			});
		}

		// The other half of that rule — a plain `project` being SEARCHED for rather
		// than refused — is deliberately not asserted here. Reaching it means
		// letting the command past its parser and into a live Smithery request, and
		// a test that needs the network to prove a parsing rule is a test that
		// fails for reasons unrelated to the rule. The dashed refusals above all
		// return before any request is made.
	});
});
