/**
 * The positional-completion tables must name commands and arguments that exist.
 *
 * WHY THIS SUITE EXISTS. `completion-gen.ts` keys its positional tables by `<command>.<arg>`, and a key
 * that matches nothing does not fail, warn, or degrade: the classifier falls through to `{ kind: "value" }`
 * and the positional completes NOTHING. That is exactly what happened to the throughput benchmark. Its
 * models positional was listed as `bench.models` while the command registers as `bench/throughput`, so
 * `veyyon bench/throughput <TAB>` offered no models at all, for as long as the rename had been in place,
 * with every completion test still green.
 *
 * The tables are the only manual mapping in a file whose whole design is to derive completions from the
 * command metadata, which makes them the one place a rename can silently break tab completion. So they are
 * checked against the real command table here: every key names a registered command, and that command
 * really declares an argument by that name.
 *
 * A comma-separated list matters too. The benchmark takes SEVERAL selectors, and a model positional pinned
 * to a single value stops offering candidates after the first one, which reads as "there are no more
 * models" rather than as a completion bug.
 */

import { describe, expect, it } from "bun:test";
import { AT_FILE_ARGS, buildSpec, FILE_ARGS, MODEL_ARGS, SETTING_ARGS } from "@veyyon/coding-agent/cli/completion-gen";
import { commands } from "@veyyon/coding-agent/cli-commands";
import type { CliConfig, CommandCtor } from "@veyyon/utils/cli";

/** Load every registered command's descriptor class, which is what `buildSpec` walks. */
async function loadCommandCtors(): Promise<Map<string, CommandCtor>> {
	const loaded = new Map<string, CommandCtor>();
	for (const entry of commands) {
		loaded.set(entry.name, (await entry.load()) as CommandCtor);
	}
	return loaded;
}

const ctors = await loadCommandCtors();

/** Every `<command>.<arg>` key the completion generator recognizes, with the table it came from. */
const KEYED_TABLES: ReadonlyArray<readonly [string, readonly string[]]> = [
	["FILE_ARGS", Object.keys(FILE_ARGS)],
	["AT_FILE_ARGS", Object.keys(AT_FILE_ARGS)],
	["MODEL_ARGS", Object.keys(MODEL_ARGS)],
	["SETTING_ARGS", Object.keys(SETTING_ARGS)],
];

describe("every positional table key names a registered command", () => {
	/**
	 * The regression this suite exists for, stated as a rule rather than as one case: a key whose command
	 * half is not a registered name can never match, so the positional it was written for completes nothing.
	 * A command name with a slash (`bench/throughput`) is the trap, since the file it lives in is `bench.ts`.
	 */
	it.each(KEYED_TABLES)("%s keys all resolve to a command", (_table, keys) => {
		const registered = new Set(ctors.keys());
		const unknown = keys.filter(key => !registered.has(key.slice(0, key.lastIndexOf("."))));

		expect(unknown).toEqual([]);
	});

	/**
	 * And the argument half has to exist on that command. A key naming a real command and a renamed
	 * argument fails the same silent way.
	 */
	it.each(KEYED_TABLES)("%s keys all name a declared argument", (_table, keys) => {
		const missing = keys.filter(key => {
			const split = key.lastIndexOf(".");
			const ctor = ctors.get(key.slice(0, split));
			return !ctor || !(key.slice(split + 1) in (ctor.args ?? {}));
		});

		expect(missing).toEqual([]);
	});

	/** Anti-vacuity: the tables are not empty and the commands really loaded, or the checks above prove nothing. */
	it("is checking real tables against real commands", () => {
		expect(KEYED_TABLES.every(([, keys]) => keys.length > 0)).toBe(true);
		expect(ctors.size).toBeGreaterThan(20);
		expect(ctors.has("bench/throughput")).toBe(true);
	});
});

describe("the throughput benchmark's model positional", () => {
	/** The spec the shells are generated from, built over the real registered commands. */
	function specForRealCommands() {
		return buildSpec({ bin: "veyyon", version: "0.0.0", commands: ctors } as CliConfig, "launch", new Map(), {});
	}

	/**
	 * Driven through the real spec rather than through a stub, because the bug was that the KEY did not
	 * match the registered name: a test that passed its own command name would have matched whatever name
	 * the table happened to hold and stayed green through the rename.
	 */
	it("completes model ids", () => {
		const command = specForRealCommands().commands.find(entry => entry.name === "bench/throughput");

		expect(command?.args.map(arg => arg.name)).toEqual(["models"]);
		expect(command?.args[0]?.value.kind).toBe("models");
	});

	/**
	 * It completes a LIST, because the argument is declared `multiple: true`. A single-value source stops
	 * offering candidates after the first selector, which is the difference between comparing two models and
	 * appearing to have only one.
	 */
	it("completes a comma-separated list of them", () => {
		const command = specForRealCommands().commands.find(entry => entry.name === "bench/throughput");
		const value = command?.args[0]?.value;

		expect(value).toEqual({ kind: "models", multiple: true });
	});

	/**
	 * The single-selector model positionals stay single. `dry-balance` and `tiny-models` each take one
	 * model, and completing them as a comma list would offer to build a list the command cannot parse.
	 */
	it.each([
		["dry-balance", "model"],
		["tiny-models", "model"],
	])("leaves %s's %s positional a single model", (commandName, argName) => {
		const command = specForRealCommands().commands.find(entry => entry.name === commandName);
		const arg = command?.args.find(entry => entry.name === argName);

		expect(arg?.value).toEqual({ kind: "models", multiple: false });
	});
});
