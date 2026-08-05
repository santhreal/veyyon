/**
 * Contract: asking WHICH commands a text client can drive does not load what they do.
 *
 * WHAT WAS WRONG. Three consumers answered one question, and all three answered it by reading
 * `command.handle !== undefined` off the assembled registry:
 *
 *   - `ACP_BUILTIN_SLASH_COMMANDS`, what an ACP client is told exists;
 *   - `ACP_BUILTIN_RESERVED_NAMES` and `isAcpBuiltinShadowedName`, which stop an extension from
 *     registering a name that builtin dispatch would capture first;
 *   - the builtin branch of `buildAvailableSlashCommands`, the list a client renders.
 *
 * `handle` is a function, so reading it means loading all 67 handler bodies, and a handler body reaches
 * the model resolver, the collab host, the OAuth providers and the session store. `available-commands.ts`
 * measured 959 modules and `acp-builtins.ts` 941 to answer three questions about metadata.
 *
 * WHY THIS IS NOT A SECOND LIST. `textMode` in `builtin-declarations.ts` is not a copy of "has a
 * handler" with a test comparing them. `HandlerSetFor` in `builtin-registry.ts` types the handler table
 * against the flag: a declaration with `textMode: true` must supply `handle`, and one without it types
 * `handle` as `never`. Both mistakes are compile errors, verified in both directions by deleting the
 * flag from `/model` (which made its handler unassignable) and adding it to `/settings` (which has
 * none). That is why the cases here check the SPLIT and the resulting VALUES rather than asserting the
 * flag equals a second list, which no test can do without loading the thing being avoided.
 *
 * WHAT STILL COSTS WHAT. `executeAcpBuiltinSlashCommand` stays in `acp-builtins.ts` and still reaches
 * the registry, because it RUNS a handler. That is correct and is the reason the module split rather
 * than moved.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	type BuiltinSlashCommandDeclaration,
} from "@veyyon/coding-agent/slash-commands/builtin-declarations";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import {
	ACP_BUILTIN_RESERVED_NAMES,
	ACP_BUILTIN_SLASH_COMMANDS,
	isAcpBuiltinShadowedName,
	TEXT_MODE_BUILTIN_DECLARATIONS,
} from "@veyyon/coding-agent/slash-commands/text-mode-builtins";
import {
	createModuleReachCache,
	type ModuleReachResolution,
	moduleReach,
	moduleSpecifiersIn,
} from "@veyyon/utils/module-reach";
import { workspaceModuleReachResolution } from "@veyyon/utils/module-reach-workspace";

const SRC = path.join(import.meta.dir, "..", "..", "src");
const REPO_ROOT = path.join(SRC, "..", "..", "..");

const RESOLUTION: ModuleReachResolution = workspaceModuleReachResolution(REPO_ROOT);
const CACHE = createModuleReachCache();

/** Every module `relative` statically reaches, as absolute paths, so an absence can be stated by name. */
function reachedFrom(relative: string): string[] {
	return [...moduleReach(path.join(SRC, relative), RESOLUTION, CACHE)];
}

function source(relative: string): string {
	return fs.readFileSync(path.join(SRC, relative), "utf8");
}

/** The widened view of the `as const` array; see the same alias in the declarations suite. */
const DECLARATIONS: readonly BuiltinSlashCommandDeclaration[] = BUILTIN_SLASH_COMMAND_DECLARATIONS;

describe("the text-mode view is a leaf", () => {
	/**
	 * Locks out: `text-mode-builtins.ts` growing an edge back into the handler registry, directly or
	 * through an intermediate, which puts every command implementation on the graph of everything that
	 * only wants to know a command's NAME.
	 *
	 * Stated as a named absence in both forms rather than as a module count. The count that used to be
	 * here (`<= 6`) predicts nothing an operator can see and drifts on growth anywhere in the two
	 * modules it legitimately reaches; the absence fails exactly when the edge comes back and names it.
	 */
	it("does not reach the registry, directly or by any path", () => {
		const specifiers = moduleSpecifiersIn(source("slash-commands/text-mode-builtins.ts"));

		expect(specifiers).not.toContain("./builtin-registry");
		expect(specifiers).toContain("./builtin-declarations");

		const reached = reachedFrom("slash-commands/text-mode-builtins.ts");

		expect(reached).not.toContain(path.join(SRC, "slash-commands", "builtin-registry.ts"));
		// The control: the walk really crossed into this directory, so the absence is about a path that
		// exists to be found and not about a walk that stopped at the entry file.
		expect(reached).toContain(path.join(SRC, "slash-commands", "builtin-declarations.ts"));
	});

	/**
	 * Locks out: the consumer that motivated the split taking the edge back. `available-commands.ts`
	 * builds the list a text client renders, and every field it reads is metadata, so a handler on its
	 * graph is 767 modules loaded to answer "which commands exist".
	 *
	 * It does NOT fall to a handful and should not: it also loads the FILE, skill, custom and
	 * MCP-prompt commands, which is real work this module owns. That is exactly why the old `<= 200`
	 * count was the wrong shape here -- the number is dominated by work that is supposed to be there.
	 */
	it("available-commands no longer reaches the handlers", () => {
		expect(moduleSpecifiersIn(source("slash-commands/available-commands.ts"))).not.toContain("./builtin-registry");

		const reached = reachedFrom("slash-commands/available-commands.ts");

		expect(reached).not.toContain(path.join(SRC, "slash-commands", "builtin-registry.ts"));
		expect(reached).toContain(path.join(SRC, "slash-commands", "text-mode-builtins.ts"));
	});

	/**
	 * And dispatch still LOADS them, at the moment it runs one. A split that cut this too would have
	 * moved the dispatcher somewhere it cannot run a handler, so the edge is what is asserted, not
	 * the absence of one.
	 *
	 * It is a dynamic import since 2026-07-27, which is why this no longer checks a static specifier
	 * or a reach above 500. `executeAcpBuiltinSlashCommand` runs on EVERY message in print and ACP
	 * mode and almost every message is a prompt, so a static edge made `veyyon -p "hello"` load 740
	 * modules of command handlers to discover the text has no slash in it: `modes/print-mode.ts`
	 * measured 960 against a ceiling of 250. It measures 227 now.
	 *
	 * The order in the source is the contract: `parseSlashCommand` is a leaf, so "is this a command
	 * at all" is answered before anything is loaded, and the registry arrives only once the answer is
	 * yes. Nothing is skipped when it is yes, which is what separates a deferral from a fallback.
	 */
	it("acp-builtins loads the handlers when it runs one, and not before", () => {
		const text = source("slash-commands/acp-builtins.ts");

		// Statically cheap: no edge to the registry at all.
		expect(moduleSpecifiersIn(text)).not.toContain("./builtin-registry");
		// And no edge to it by ANY path, which the direct check alone cannot say: one intermediate module
		// naming the registry statically puts all 740 handler modules back on the startup graph while the
		// direct-specifier assertion above stays green. Stated as an absence by name rather than as a
		// module count, and never as a search of the source text: this file's own comments name the
		// module, so a text scan would fail for the opposite of its purpose, and it would also pass while
		// the edge came back through a rename.
		const reached = reachedFrom("slash-commands/acp-builtins.ts");

		expect(reached).not.toContain(path.join(SRC, "slash-commands", "builtin-registry.ts"));
		// The control: the walk did happen and does cross into this directory, so the absence above is a
		// statement about a path that exists to be found rather than about a walk that stopped early.
		expect(reached).toContain(path.join(SRC, "slash-commands", "builtin-declarations.ts"));
	});

	/**
	 * The behaviour behind the deferral, driven rather than read: a real command still runs, and a
	 * plain prompt is still refused. Without this the assertions above are satisfied by a dispatcher
	 * that loads the registry and then does nothing with it.
	 */
	it("still runs a real builtin and still declines a plain prompt", async () => {
		const { executeAcpBuiltinSlashCommand } = await import("@veyyon/coding-agent/slash-commands/acp-builtins");
		const lines: string[] = [];
		const runtime = { output: (text: string) => lines.push(text) } as never;

		// Not a command: refused before anything is loaded.
		expect(await executeAcpBuiltinSlashCommand("just a prompt", runtime)).toBe(false);
		// A command shape with no such builtin: the registry IS loaded, and says no.
		expect(await executeAcpBuiltinSlashCommand("/definitely-not-a-command", runtime)).toBe(false);
		// A real text-mode builtin: loaded and run. `/thinking` with no argument reports the current
		// level and the choices, which is the smallest handler that needs nothing but the two session
		// reads stubbed below, so the assertion is about dispatch rather than about a command's state.
		const withSession = {
			output: (text: string) => lines.push(text),
			session: {
				configuredThinkingLevel: () => "high",
				getAvailableThinkingLevels: () => ["low", "medium", "high"],
			},
		} as never;
		const result = await executeAcpBuiltinSlashCommand("/thinking", withSession);

		expect(result).toEqual({ consumed: true });
		expect(lines.join("\n")).toContain("Effort: high");
		expect(lines.join("\n")).toContain("low, medium, high");
	});
});

describe("the declared flag and the handler table agree", () => {
	/**
	 * THE INVARIANT the types enforce, asserted here as VALUES so a reader can see it holds rather
	 * than trusting a type they cannot run. Every declaration with `textMode` has a real `handle` on
	 * its assembled spec.
	 */
	it("every text-mode declaration has a handler", () => {
		const byName = new Map(BUILTIN_SLASH_COMMANDS_INTERNAL.map(command => [command.name, command]));

		for (const declaration of TEXT_MODE_BUILTIN_DECLARATIONS) {
			const spec = byName.get(declaration.name);
			expect(spec, `${declaration.name} is declared but not assembled`).toBeDefined();
			expect(typeof spec?.handle, `${declaration.name} declares textMode with no handler`).toBe("function");
		}
	});

	/**
	 * THE OTHER DIRECTION, and the one that would let the flag rot silently: no command has a text
	 * handler without declaring the flag. Without this case, declaring `textMode` on nothing at all
	 * would satisfy the case above.
	 */
	it("no command has a handler without declaring text mode", () => {
		const declared = new Set(TEXT_MODE_BUILTIN_DECLARATIONS.map(declaration => declaration.name));
		const undeclared = BUILTIN_SLASH_COMMANDS_INTERNAL.filter(
			command => command.handle !== undefined && !declared.has(command.name),
		).map(command => command.name);

		expect(undeclared).toEqual([]);
	});

	/**
	 * The counts, pinned. 30 of the 68 builtins are drivable from text; the rest are TUI surfaces such
	 * as `/settings`, `/cockpit` and `/quit` that an ACP client cannot render. A change to either
	 * number is a real product change and should be a deliberate edit here.
	 *
	 * They moved when `/secret` was added: it is text-drivable on purpose, because its recommended
	 * form (`--from-env`) never needs a terminal to type a value into, and a headless client is
	 * exactly where reading a credential out of the environment is the only sane option.
	 *
	 * They moved again for `/permissions`, which is text-drivable for a stronger reason: it names the
	 * approval rung, and a headless client is the surface where a rung that prompts cannot be
	 * answered at all. Denying it the one command that changes the rung would leave such a client
	 * with no route out of a configuration that blocks every write.
	 */
	it("30 of the 68 builtins are text-drivable", () => {
		expect(DECLARATIONS.length).toBe(68);
		expect(TEXT_MODE_BUILTIN_DECLARATIONS.length).toBe(30);
	});

	/**
	 * Declared ORDER survives the filter, because the ACP advertisement is rendered in the order it
	 * arrives and a client shows the palette in that order.
	 */
	it("keeps the declared order", () => {
		const expected = DECLARATIONS.filter(declaration => declaration.textMode === true).map(
			declaration => declaration.name,
		);

		expect(TEXT_MODE_BUILTIN_DECLARATIONS.map(declaration => declaration.name)).toEqual(expected);
	});

	/**
	 * A TUI-only command is really absent, not merely last. `/settings` is the plainest example: it
	 * opens a selector, so there is nothing for a text client to do with it.
	 */
	it("leaves the TUI-only commands out", () => {
		const names = TEXT_MODE_BUILTIN_DECLARATIONS.map(declaration => declaration.name);

		expect(names).not.toContain("settings");
		expect(names).not.toContain("cockpit");
		expect(names).not.toContain("quit");
		expect(names).toContain("model");
		expect(names).toContain("compact");
	});
});

describe("the reserved names cover aliases", () => {
	/**
	 * The bug this set exists to prevent: `models` is an alias for `/model`, so an extension that
	 * registered `models` would be advertised and then dispatch to the builtin. The alias has to be
	 * reserved, not just the primary name.
	 */
	it("reserves an alias of a text-mode command", () => {
		expect(ACP_BUILTIN_RESERVED_NAMES.has("model")).toBe(true);
		expect(ACP_BUILTIN_RESERVED_NAMES.has("models")).toBe(true);
	});

	/**
	 * And it does NOT reserve a TUI-only command's name, which is the boundary: an extension may
	 * legitimately register `settings` for a text client, because no builtin will capture it there.
	 */
	it("does not reserve a name only the TUI can dispatch", () => {
		expect(ACP_BUILTIN_RESERVED_NAMES.has("settings")).toBe(false);
		expect(ACP_BUILTIN_RESERVED_NAMES.has("help")).toBe(false);
	});

	/**
	 * The set is exactly the text-mode names and their aliases, with nothing left over. An orphan
	 * would mean a name is reserved against a command that no longer exists, which silently blocks an
	 * extension for no reason.
	 */
	it("holds nothing beyond the text-mode names and their aliases", () => {
		const expected = new Set(
			TEXT_MODE_BUILTIN_DECLARATIONS.flatMap(declaration => [declaration.name, ...(declaration.aliases ?? [])]),
		);

		expect([...ACP_BUILTIN_RESERVED_NAMES].sort()).toEqual([...expected].sort());
	});

	/**
	 * The colon rule, which is the non-obvious half. `parseSlashCommand` splits a name on `:`, so
	 * `model:foo` runs `/model` with `foo`, and a name whose PREFIX is reserved must be treated as
	 * shadowed even though the full name is not in the set.
	 */
	it("treats a colon-namespaced name with a reserved prefix as shadowed", () => {
		expect(isAcpBuiltinShadowedName("model:foo")).toBe(true);
		expect(isAcpBuiltinShadowedName("models:foo")).toBe(true);
		expect(isAcpBuiltinShadowedName("settings:foo")).toBe(false);
		expect(isAcpBuiltinShadowedName("modelfoo")).toBe(false);
	});
});

describe("the ACP advertisement", () => {
	/**
	 * One entry per text-mode command, in the same order, so the advertisement cannot silently drop
	 * one.
	 */
	it("advertises every text-mode command once, in order", () => {
		expect(ACP_BUILTIN_SLASH_COMMANDS.map(command => command.name)).toEqual(
			TEXT_MODE_BUILTIN_DECLARATIONS.map(declaration => declaration.name),
		);
	});

	/**
	 * Mode-specific copy WINS where it is declared. `/model` declares an `acpDescription` precisely
	 * because its TUI description talks about switching, while in text mode it reports the current
	 * selection, and a client shown the TUI wording would be told the command does something else.
	 */
	it("prefers the ACP description over the unified one", () => {
		const declaration = TEXT_MODE_BUILTIN_DECLARATIONS.find(entry => entry.name === "model");
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(command => command.name === "model");

		expect(declaration?.acpDescription).toBeDefined();
		expect(declaration?.acpDescription).not.toBe(declaration?.description);
		expect(advertised?.description).toBe(declaration?.acpDescription ?? "");
	});

	/**
	 * And falls back to the unified description when no ACP copy is declared, so a command without
	 * mode-specific wording is still described rather than advertised blank.
	 */
	it("falls back to the unified description", () => {
		const plain = TEXT_MODE_BUILTIN_DECLARATIONS.find(entry => entry.acpDescription === undefined);
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(command => command.name === plain?.name);

		expect(plain).toBeDefined();
		expect(advertised?.description).toBe(plain?.description ?? "");
	});

	/**
	 * The input hint follows the same precedence, and a command with no hint at all advertises
	 * `undefined` rather than an empty hint object, which a client would render as an empty argument
	 * prompt.
	 */
	it("carries the input hint with the same precedence", () => {
		for (const declaration of TEXT_MODE_BUILTIN_DECLARATIONS) {
			const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(command => command.name === declaration.name);
			const hint = declaration.acpInputHint ?? declaration.inlineHint;

			expect(advertised?.input, `${declaration.name}`).toEqual(hint ? { hint } : undefined);
		}
	});

	/**
	 * `/thinking` is the concrete case for the hint, and worth naming: its ACP hint lists the effort
	 * levels a text client must send, which the TUI hint does not.
	 */
	it("advertises the effort levels for /thinking", () => {
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(command => command.name === "thinking");

		expect(advertised?.input?.hint).toBe("[minimal|low|medium|high|xhigh|auto|off]");
	});
});
