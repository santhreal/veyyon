/**
 * WHY THIS EXISTS. Deciding whether typed text names a builtin slash command used to require every
 * builtin. The check was `BUILTIN_SLASH_COMMAND_LOOKUP.get(name)`, the lookup is built from the
 * handler bodies, and a handler body reaches the application, so the two callers that run on every
 * submitted line — `main.ts` and the TUI input controller — carried the whole registry to answer a
 * question that is "no" for most input. It cost the launch graph 98 modules and the input controller
 * 240.
 *
 * `slash-commands/dispatch.ts` answers it from the declarations instead, which import nothing, and
 * loads the registry only after a name has matched. The saving is entirely in the edge NOT being
 * there, which is invisible to every behavioural test: the product works identically with the static
 * import restored, so nothing else in this repository would report the regression.
 *
 * WHAT IT CLOSES. Not "main.ts does not import the registry today". The class is "a caller reaches
 * the builtin handlers in order to decide it does not need them". So the absent edges are stated for
 * each caller, the domain modules are derived from the category map at run time rather than listed,
 * and the same walk proves the registry DOES reach them — without which every `not.toContain` here
 * would pass on a misspelled path.
 *
 * Behaviour is asserted beside the graph, because an edge that is cut by breaking the feature is not
 * a saving: a name that is not a builtin must still be refused, and one that is must still run.
 *
 * WHAT IT DOES NOT CATCH. A cost paid through a DIFFERENT edge. If `main.ts` grows an import of
 * something that itself imports the registry, the named absence below goes red, but a caller that is
 * not named here can pay the cost unobserved.
 */
import { describe, expect, it } from "bun:test";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { BUILTIN_SLASH_COMMAND_CATEGORIES } from "@veyyon/coding-agent/slash-commands/builtin-categories";
import { dispatchBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/dispatch";
import { reachedNames } from "../helpers/module-reach-gate";

const REGISTRY = "coding-agent/src/slash-commands/builtin-registry.ts";

/** The domain modules, named the way the reach walk names them, derived from the category map. */
function domainModules(): string[] {
	return [...new Set(Object.values(BUILTIN_SLASH_COMMAND_CATEGORIES))]
		.map(domain => `coding-agent/src/slash-commands/builtin-${domain}.ts`)
		.sort();
}

/**
 * A host context that RECORDS what the command did to it.
 *
 * The values are what the assertions read, rather than whether a function was called: `/btw` is
 * correct when the question that reaches the host is the text after the command, and wrong when it
 * is the whole line or a truncation of it, which a call-count cannot tell apart.
 */
function createRuntime() {
	const observed: { question?: string; editorText?: string } = {};
	return {
		observed,
		runtime: {
			ctx: {
				editor: {
					setText: (text: string) => {
						observed.editorText = text;
					},
					addToHistory: () => {},
				} as unknown as InteractiveModeContext["editor"],
				handleBtwCommand: async (question: string) => {
					observed.question = question;
				},
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("deciding a name is not a builtin does not load the builtins", () => {
	/**
	 * The walk resolves, and the names below are the names it produces. Both halves matter: a
	 * resolution table that stopped early would make every absence true, and a misspelled module path
	 * would make every absence true for the wrong reason.
	 *
	 * The registry reached 866 modules once the heavy handlers (`/secret`, `/mcp`, `/ssh`, the plugin
	 * manager) moved behind first use, down from over 1000. The floor sits below that and far above
	 * what a walk that stops at the first package boundary reaches.
	 */
	it("walks a graph that really contains the builtins", () => {
		const fromRegistry = reachedNames("slash-commands/builtin-registry.ts");

		expect(fromRegistry.length).toBeGreaterThan(800);
		for (const domain of domainModules()) {
			expect(fromRegistry, `the registry no longer reaches ${domain}`).toContain(domain);
		}
	});

	it("keeps the front door off the registry and off every domain module", () => {
		const fromDispatch = reachedNames("slash-commands/dispatch.ts");

		expect(
			fromDispatch,
			"dispatch.ts imports the registry statically, which is the cost it exists to avoid",
		).not.toContain(REGISTRY);
		for (const domain of domainModules()) {
			expect(fromDispatch).not.toContain(domain);
		}
	});

	it("keeps the two callers that run on every submitted line off the registry", () => {
		expect(reachedNames("main.ts")).not.toContain(REGISTRY);
		expect(reachedNames("modes/terminal/controllers/input-controller.ts")).not.toContain(REGISTRY);
	});

	/**
	 * The two modules the split created below the domains. A shared helper or a completion builder
	 * that grows an edge into the handlers puts that cost back into everything the domains import,
	 * which is the shape of the defect this whole file is about.
	 */
	it("keeps the shared helpers and the completion builders below the handlers", () => {
		expect(reachedNames("slash-commands/builtin-shared.ts")).toEqual([
			"coding-agent/src/slash-commands/builtin-shared.ts",
		]);

		const fromCompletions = reachedNames("slash-commands/builtin-completions.ts");
		expect(fromCompletions).not.toContain(REGISTRY);
		for (const domain of domainModules()) {
			expect(fromCompletions).not.toContain(domain);
		}
	});

	/**
	 * The eight domains are independent, which is what makes them eight modules rather than one file
	 * with headings. A helper used by two domains belongs in `builtin-shared.ts`; reaching sideways
	 * for it instead makes one domain pay for another's imports, and enough of those edges rebuild
	 * the object this split came out of, one import at a time and with nothing reporting it.
	 */
	it("keeps every domain module independent of the other seven", () => {
		const domains = domainModules();

		for (const domain of domains) {
			const relative = domain.replace("coding-agent/src/", "");
			const reached = reachedNames(relative);
			const siblings = domains.filter(other => other !== domain).filter(other => reached.includes(other));

			expect(siblings, `${domain} reaches another domain; a shared helper belongs in builtin-shared.ts`).toEqual([]);
		}
	});

	it("still refuses a name that is not a builtin", async () => {
		const harness = createRuntime();

		expect(await dispatchBuiltinSlashCommand("/definitely-not-a-builtin", harness.runtime)).toBe(false);
		expect(await dispatchBuiltinSlashCommand("not a slash command at all", harness.runtime)).toBe(false);
		expect(harness.observed.editorText).toBeUndefined();
	});

	it("still runs a name that is one, loading the handlers on the way", async () => {
		const harness = createRuntime();

		const handled = await dispatchBuiltinSlashCommand("/btw why is it doing that?", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.observed.question).toBe("why is it doing that?");
	});
});
