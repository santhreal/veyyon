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
	 * Locks out: a fourth import into the declarations file, which undoes the whole split. Each name
	 * below is a subsystem a handler body reaches and a command NAME does not need, and each is one
	 * import away from returning.
	 *
	 * Stated as named absences rather than as a count. The count that used to sit above this (`<= 6`
	 * against a measurement of 3) could be satisfied by an import of any small module and could be
	 * broken by growth in the two leaves this file legitimately references, so it neither caught the
	 * regression it names nor stayed quiet about the growth it does not care about.
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

	/**
	 * A floor on the count, so the case above cannot pass by both sides being empty.
	 *
	 * The split started from 67, went to 66, and is now 67 again. Both moves are recorded because
	 * the number is only useful if a change to it has to be justified:
	 *
	 *   - DOWN to 66: `/cockpit` (with its `/hub` alias) was folded into `/agents` as an alias when
	 *     the Agent Hub overlay and the Agent Control Center stopped being two screens. A command
	 *     that becomes an alias of another leaves the set of NAMES unchanged and the set of
	 *     DECLARATIONS one shorter, which is exactly what this number counts.
	 *   - UP to 67: `/secret` was added, storing a credential the agent can reference by
	 *     placeholder without ever seeing its value.
	 *   - UP to 68: `/permissions` was added, setting the tool-approval rung for one session
	 *     without touching the saved default. It exists because the rung became something an
	 *     operator changes mid-task once the ladder replaced `yolo` with a shipped default of `auto`.
	 *   - UP to 70: `/providers` and `/account` were added by the account manager. `/providers` was
	 *     an ALIAS of `/setup` before, so it was not counted here; it is now its own declaration
	 *     because it opens the account manager instead of the onboarding wizard, and `/account` is
	 *     the inline per-provider report and the row actions that reach the same accounts without
	 *     a view.
	 *   - UP to 71: `/cpu-limit` was added. `session.cpuLimitCores` is a per-profile setting, so a
	 *     session that needs a different budget than the profile chose had no way to say so, and no
	 *     way to lift the cap for one piece of work without editing the profile.
	 */
	it("there are the 71 builtins the declarations hold", () => {
		expect(BUILTIN_SLASH_COMMAND_DECLARATIONS.length).toBe(71);
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
