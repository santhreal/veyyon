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
	moduleReachCount,
	moduleSpecifiersIn,
} from "@veyyon/utils/module-reach";
import { workspaceModuleReachResolution } from "@veyyon/utils/module-reach-workspace";

const SRC = path.join(import.meta.dir, "..", "..", "src");
const REPO_ROOT = path.join(SRC, "..", "..", "..");

const RESOLUTION: ModuleReachResolution = workspaceModuleReachResolution(REPO_ROOT);
const CACHE = createModuleReachCache();

function reach(relative: string): number {
	return moduleReachCount(path.join(SRC, relative), RESOLUTION, CACHE);
}

function source(relative: string): string {
	return fs.readFileSync(path.join(SRC, relative), "utf8");
}

/** The widened view of the `as const` array; see the same alias in the declarations suite. */
const DECLARATIONS: readonly BuiltinSlashCommandDeclaration[] = BUILTIN_SLASH_COMMAND_DECLARATIONS;

describe("the text-mode view is a leaf", () => {
	/**
	 * The whole point of the split. If this ceiling ever rises past a handful, something in the chain
	 * started importing a handler again and every consumer below pays for it.
	 */
	it("reaches only the declarations it reads", () => {
		expect(reach("slash-commands/text-mode-builtins.ts")).toBeLessThanOrEqual(6);
	});

	/**
	 * Named absence, not just a number. A ceiling can be satisfied by a module that imports the
	 * registry through a path the counter fails to resolve, and this states the one specifier that
	 * must never appear.
	 */
	it("does not import the registry", () => {
		const specifiers = moduleSpecifiersIn(source("slash-commands/text-mode-builtins.ts"));

		expect(specifiers).not.toContain("./builtin-registry");
		expect(specifiers).toContain("./builtin-declarations");
	});

	/**
	 * The consumer that motivated the split. `available-commands.ts` builds the list a client renders,
	 * and every field it reads is metadata, so it has no business loading a handler.
	 */
	it("available-commands no longer reaches the handlers", () => {
		// 959 before, 192 after. It does not fall to a handful, and should not: it also loads the
		// FILE, skill, custom and MCP-prompt commands, which is real work this module owns. What went
		// away is the 767 modules it paid to ask which builtins a text client can drive.
		expect(reach("slash-commands/available-commands.ts")).toBeLessThanOrEqual(200);
		expect(moduleSpecifiersIn(source("slash-commands/available-commands.ts"))).not.toContain("./builtin-registry");
	});

	/**
	 * And dispatch DOES still reach them, which is the half that should. A split that cut this too
	 * would have moved the dispatcher somewhere it cannot run a handler.
	 */
	it("acp-builtins still reaches the handlers, because it runs them", () => {
		expect(reach("slash-commands/acp-builtins.ts")).toBeGreaterThan(500);
		expect(moduleSpecifiersIn(source("slash-commands/acp-builtins.ts"))).toContain("./builtin-registry");
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
	 * The counts, pinned. 28 of the 67 builtins are drivable from text; the rest are TUI surfaces such
	 * as `/settings`, `/cockpit` and `/quit` that an ACP client cannot render. A change to either
	 * number is a real product change and should be a deliberate edit here.
	 */
	it("28 of the 67 builtins are text-drivable", () => {
		expect(DECLARATIONS.length).toBe(67);
		expect(TEXT_MODE_BUILTIN_DECLARATIONS.length).toBe(28);
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
