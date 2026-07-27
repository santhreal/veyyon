/**
 * Contract: knowing that `/model` exists does not mean loading what `/model` does.
 *
 * WHAT WAS WRONG. `builtin-registry.ts` held 67 objects, each carrying a command's NAME, aliases and
 * description next to the handler body that implements it. A handler body reaches the whole
 * application: the model resolver, the collab host, the OAuth providers, the settings selector, the
 * session store. So the array that answers "which names are taken" was welded to the array that
 * answers "what happens when you type this", and two modules that wanted only the first paid for both.
 *
 *   - `extensibility/extensions/get-commands-handler.ts` imports `BUILTIN_SLASH_COMMAND_RESERVED_NAMES`
 *     and NOTHING else, so that an extension cannot register a command that shadows a builtin. That
 *     one import measured 770 modules of marginal cost. 945 -> 178.
 *   - It propagated straight into the interactive path: `modes/runtime-init.ts` 947 -> 219, and
 *     `modes/print-mode.ts`, which is `veyyon -p`, 949 -> 221.
 *
 * WHY THIS IS NOT TWO LISTS. The obvious cheap fix is a hand-kept array of reserved names in a leaf,
 * with a test asserting it matches the registry. That is two places with a gate over them, and the
 * gate is what a rushed change deletes. Instead the NAMES are declared once, in
 * `builtin-declarations.ts`, and the registry attaches handlers to them through a
 * `Record<BuiltinSlashCommandName, ...>` keyed by the union derived from that array. A handler for a
 * command that does not exist and a command with no handler are both COMPILE errors. There is nothing
 * for a test to keep in sync, which is why the cases below check the SPLIT rather than the contents.
 *
 * WHAT STILL COSTS WHAT. `acp-builtins.ts` still reaches the handlers, and it should: it dispatches
 * them, and it decides what to advertise by asking which commands have a text-mode handler. That is a
 * fact about the handler table, not about the declarations.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	BUILTIN_SLASH_COMMAND_RESERVED_NAMES,
	type BuiltinSlashCommandDeclaration,
} from "@veyyon/coding-agent/slash-commands/builtin-declarations";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import {
	createModuleReachCache,
	type ModuleReachResolution,
	moduleReach,
	moduleReachCount,
	moduleSpecifiersIn,
} from "@veyyon/utils/module-reach";
import { workspaceModuleReachResolution } from "@veyyon/utils/module-reach-workspace";

const SRC = path.join(import.meta.dir, "..", "..", "src");
const REPO_ROOT = path.join(SRC, "..", "..", "..");

/**
 * `BUILTIN_SLASH_COMMAND_DECLARATIONS` is declared `as const`, so its element type is a union of 67
 * exact object literals and the optional fields exist only on the members that set them. That is the
 * point: it is what makes `BuiltinSlashCommandName` a closed union. Reading an optional field off the
 * union needs the declared interface, so the cases below go through this widened view rather than
 * asking each literal member whether it happens to have `subcommands`.
 */
const DECLARATIONS: readonly BuiltinSlashCommandDeclaration[] = BUILTIN_SLASH_COMMAND_DECLARATIONS;

const RESOLUTION: ModuleReachResolution = workspaceModuleReachResolution(REPO_ROOT);
const CACHE = createModuleReachCache();

function reach(relative: string): number {
	return moduleReachCount(path.join(SRC, relative), RESOLUTION, CACHE);
}

function reachedNames(relative: string): string[] {
	return [...moduleReach(path.join(SRC, relative), RESOLUTION, CACHE)]
		.map(file => path.relative(REPO_ROOT, file))
		.sort();
}

function runtimeImportsOf(relative: string): string[] {
	return moduleSpecifiersIn(fs.readFileSync(path.join(SRC, relative), "utf-8"));
}

describe("the declarations are a leaf", () => {
	/**
	 * Measured at 3: itself, the priority-tier label and the compaction mode table, both of which are
	 * one-module leaves and both of which this file must reference rather than restate. The ceiling is
	 * deliberately tight, because a fourth import of any size undoes the whole split.
	 */
	it("reaches at most 6 modules", () => {
		expect(reach("slash-commands/builtin-declarations.ts")).toBeLessThanOrEqual(6);
	});

	/**
	 * The absences, NAMED. Each is a subsystem a handler body reaches and a command name does not
	 * need, and each is one import away from returning.
	 */
	it("reaches none of the application a handler reaches", () => {
		const reached = reachedNames("slash-commands/builtin-declarations.ts");

		expect(reached).not.toContain(
			path.join("packages", "coding-agent", "src", "slash-commands", "builtin-registry.ts"),
		);
		expect(reached).not.toContain(path.join("packages", "coding-agent", "src", "collab", "host.ts"));
		expect(reached).not.toContain(path.join("packages", "coding-agent", "src", "config", "model-resolver.ts"));
		expect(reached).not.toContain(path.join("packages", "ai", "src", "stream.ts"));
	});

	/**
	 * NON-VACUITY for the absences: the walk resolved this module and really does see its two leaf
	 * imports, so "reaches none of those" is a fact about the graph rather than what an unresolvable
	 * path returns for free.
	 */
	it("does reach the two leaves it references", () => {
		const reached = reachedNames("slash-commands/builtin-declarations.ts");

		expect(reached).toContain(path.join("packages", "coding-agent", "src", "config", "service-tier.ts"));
		expect(reached).toContain(path.join("packages", "coding-agent", "src", "session", "compact-modes.ts"));
	});
});

describe("the modules that only wanted the names", () => {
	/**
	 * Ceilings, each a little above its measurement. The extension handler is the one that motivated
	 * the split; the other two are what it was costing, and they are on the interactive and print
	 * paths, which is where a cold start is felt.
	 */
	it.each([
		["extensibility/extensions/get-commands-handler.ts", 200],
		["modes/runtime-init.ts", 250],
		["modes/print-mode.ts", 250],
	])("%s reaches at most %i modules", (relative, ceiling) => {
		expect(reach(relative)).toBeLessThanOrEqual(ceiling);
	});

	/**
	 * The edge itself, by SPECIFIER, which is the assertion that names the fix. Both modules export
	 * `BUILTIN_SLASH_COMMAND_RESERVED_NAMES` under the same name and the registry re-exports the
	 * declarations' set, so the two spellings compile identically, behave identically, and differ by
	 * 767 modules.
	 */
	it("the extension handler names the declarations, not the registry", () => {
		const imports = runtimeImportsOf("extensibility/extensions/get-commands-handler.ts");

		expect(imports).toContain("../../slash-commands/builtin-declarations");
		expect(imports).not.toContain("../../slash-commands/builtin-registry");
	});

	/** And none of the three reaches the registry any more, which is what the ceilings are about. */
	it.each(["extensibility/extensions/get-commands-handler.ts", "modes/runtime-init.ts", "modes/print-mode.ts"])(
		"%s does not reach the registry",
		relative => {
			expect(reachedNames(relative)).not.toContain(
				path.join("packages", "coding-agent", "src", "slash-commands", "builtin-registry.ts"),
			);
		},
	);
});

describe("the split kept one set of commands", () => {
	/**
	 * THE CASE THAT MATTERS MOST, and the reason it compares two runtime values rather than reading
	 * source: a split that dropped a command would satisfy every ceiling above and every absence, and
	 * the missing command would simply stop existing. The declared names and the assembled registry
	 * must be the same list, in the same order.
	 */
	it("every declaration became a registry entry, in order", () => {
		expect(BUILTIN_SLASH_COMMANDS_INTERNAL.map(command => command.name)).toEqual(
			BUILTIN_SLASH_COMMAND_DECLARATIONS.map(declaration => declaration.name),
		);
	});

	/** A floor on the count, so the case above cannot pass by both sides being empty. */
	it("there are the 67 builtins the split started from", () => {
		expect(BUILTIN_SLASH_COMMAND_DECLARATIONS.length).toBe(67);
	});

	/**
	 * Every assembled entry carries at least one handler. The `Record` makes a MISSING key a compile
	 * error, but an empty object `{}` satisfies the type, so this is the case that catches a handler
	 * body lost in the move rather than a key.
	 */
	it("every command still has something to run", () => {
		const inert = BUILTIN_SLASH_COMMANDS_INTERNAL.filter(
			command => command.handle === undefined && command.handleTui === undefined,
		).map(command => command.name);

		expect(inert).toEqual([]);
	});

	/**
	 * The reserved set covers names AND aliases, checked against a real alias rather than by counting.
	 * `help` is an alias for `/welcome`, and it is the case that would break if the derivation
	 * silently dropped the alias half: an extension called `help` would then be allowed to shadow the
	 * first command a new user types.
	 */
	it("reserves aliases as well as names", () => {
		expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has("welcome")).toBe(true);
		expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has("help")).toBe(true);
		expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.size).toBeGreaterThan(BUILTIN_SLASH_COMMAND_DECLARATIONS.length);
	});

	/** And it reserves nothing that is not declared, which is the other half of "derived, not written". */
	it("reserves nothing that no command answers to", () => {
		const answered = new Set(
			BUILTIN_SLASH_COMMANDS_INTERNAL.flatMap(command => [command.name, ...(command.aliases ?? [])]),
		);
		const orphans = [...BUILTIN_SLASH_COMMAND_RESERVED_NAMES].filter(name => !answered.has(name));

		expect(orphans).toEqual([]);
	});

	/**
	 * The registry hands out COPIES of the declared arrays. The declarations are shared and frozen by
	 * `as const` at the type level only, so a consumer that sorted a spec's `subcommands` in place
	 * would otherwise reorder them for every other consumer, including the ACP advertisement.
	 */
	it("does not share a mutable array with the declarations", () => {
		const withSubcommands = BUILTIN_SLASH_COMMANDS_INTERNAL.find(command => (command.subcommands?.length ?? 0) > 0);
		const declared = DECLARATIONS.find(declaration => declaration.name === withSubcommands?.name);

		expect(withSubcommands?.subcommands).toBeDefined();
		expect(withSubcommands?.subcommands).not.toBe(declared?.subcommands);
		expect(withSubcommands?.subcommands?.map(sub => sub.name)).toEqual(
			(declared?.subcommands ?? []).map(sub => sub.name),
		);
	});
});
