import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AdvisorConfigOverlayComponent } from "@veyyon/coding-agent/modes/components/advisor-config";
import {
	CommandController,
	type CommandControllerContext,
} from "@veyyon/coding-agent/modes/controllers/command-controller";
import {
	SelectorController,
	type SelectorControllerContext,
} from "@veyyon/coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	type BuiltinSlashCommandDeclaration,
} from "@veyyon/coding-agent/slash-commands/builtin-declarations";
import {
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "@veyyon/coding-agent/slash-commands/builtin-registry";
import type {
	ParsedSlashCommand,
	SlashCommandRuntime,
	SubcommandDef,
	TuiSlashCommandRuntime,
} from "@veyyon/coding-agent/slash-commands/types";
import { TempDir } from "@veyyon/utils";

/**
 * WHY. The advisor subsystem shipped complete and unreachable. `packages/coding-agent/src/advisor/`
 * held a roster loaded from `WATCHDOG.yml`, per-advisor models, tools and instructions, plus
 * `getAdvisorStats`, `formatAdvisorStatus`, `formatAdvisorHistoryAsText` and a full-screen roster
 * editor that had its own render tests — while the three handlers that reach them answered
 * "Advisor/watchdog was removed from Veyyon." That string was inherited from upstream, where the
 * feature really was removed, and stopped being true when the subsystem was re-added. No slash
 * command, keybinding or menu row called any of the three, so the editor had no entry point at all.
 *
 * THE CLASS. A subsystem that is live in the runtime while the surfaces that reach it report it as
 * absent, and a declared subcommand that silently does nothing. Both survive review because each
 * half reads as correct on its own: the handler is a plausible stub, and the runtime is plausible
 * code. Only crossing the two catches it.
 *
 * HOW IT IS CLOSED. The verb sweep enumerates `/advisor`'s subcommands from the declaration at run
 * time and asserts, by exact set equality, that every one reaches a distinct effect. Adding a
 * subcommand to the declaration without a dispatch branch turns this file red rather than shipping
 * a verb that falls through to the usage line. The behavioral cases below drive the real
 * `CommandController` so the reported text comes from the session rather than a constant.
 *
 * WHAT IT DOES NOT CATCH. It does not prove the advisor produces good advice, that the roster
 * editor writes valid YAML (`advisor.test.ts` covers the editor's rendering and its save contract),
 * or that `applyAdvisorConfigs` rebuilds the runtime correctly — only that the front door reaches
 * the subsystem instead of denying it exists. It also cannot see a regression in a surface that
 * does not go through `executeBuiltinSlashCommand`.
 */

const ALL_DECLARATIONS: readonly BuiltinSlashCommandDeclaration[] = BUILTIN_SLASH_COMMAND_DECLARATIONS;

const ADVISOR_DECLARATION = ALL_DECLARATIONS.find(declaration => declaration.name === "advisor");

/** Declared verbs, read from source at run time so a new one cannot be added unnoticed. */
function declaredVerbs(): readonly string[] {
	const subcommands: readonly SubcommandDef[] = ADVISOR_DECLARATION?.subcommands ?? [];
	return subcommands.map(sub => sub.name);
}

const USAGE_LINE = "Usage: /advisor [status|configure|on|off|dump]";

interface AdvisorSessionShape {
	configured: boolean;
	/** What `setAdvisorEnabled(true)` resolves to: false models the "no advisor model" case. */
	startsWhenEnabled: boolean;
	transcript: string | null;
}

interface Probe {
	statuses: string[];
	errors: string[];
	touched: string[];
	toggledWith: boolean[];
	/** What the text-mode handler emitted, which is a separate route from `statuses`. */
	printed: string[];
	runtime: TuiSlashCommandRuntime;
	textRuntime: SlashCommandRuntime;
}

function probe(shape: Partial<AdvisorSessionShape> = {}): Probe {
	const configured = shape.configured ?? true;
	const startsWhenEnabled = shape.startsWhenEnabled ?? true;
	const transcript = shape.transcript === undefined ? "## advisor transcript" : shape.transcript;

	const statuses: string[] = [];
	const errors: string[] = [];
	const touched: string[] = [];
	const toggledWith: boolean[] = [];

	const session = {
		getAdvisorStats: () => ({
			configured,
			active: configured && startsWhenEnabled,
			advisors:
				configured && startsWhenEnabled
					? [{ name: "default", model: { provider: "anthropic", id: "claude-probe" } }]
					: [],
		}),
		formatAdvisorStatus: () => (configured && startsWhenEnabled ? "Advisor is enabled." : "Advisor is disabled."),
		formatAdvisorHistoryAsText: () => transcript,
		setAdvisorEnabled: (enabled: boolean) => {
			touched.push("setAdvisorEnabled");
			toggledWith.push(enabled);
			return enabled && startsWhenEnabled;
		},
		isAdvisorEnabled: () => configured,
	};

	const ctx = {
		collabGuest: undefined,
		editor: { setText: () => {} },
		ui: { requestRender: () => {} },
		session,
		showStatus: (text: string) => {
			statuses.push(text);
		},
		showError: (text: string) => {
			errors.push(text);
		},
		handleAdvisorStatusCommand: async () => {
			touched.push("handleAdvisorStatusCommand");
		},
		showAdvisorConfigure: async () => {
			touched.push("showAdvisorConfigure");
		},
		handleAdvisorDumpCommand: () => {
			touched.push("handleAdvisorDumpCommand");
		},
	} as unknown as InteractiveModeContext;

	const printed: string[] = [];
	// The text-mode runtime carries the same session; only the two fields the advisor handler
	// reaches are real, which is why the shape is asserted once here rather than at each use.
	const textRuntime = {
		session,
		output: (text: string) => {
			printed.push(text);
		},
	} as unknown as SlashCommandRuntime;

	return { statuses, errors, touched, toggledWith, printed, runtime: { ctx }, textRuntime };
}

describe("the /advisor command reaches the advisor", () => {
	it("is declared, so it is reachable by typing it", () => {
		expect(ADVISOR_DECLARATION).toBeDefined();
	});

	/**
	 * The class gate. Every declared verb must reach an effect of its own; none may fall through to
	 * the usage line. Asserting the dispatched set EQUALS the declared set (rather than counting, or
	 * spot-checking one verb) is what makes a newly declared subcommand fail here by default.
	 */
	it("dispatches every subcommand it declares, and none falls through to the usage line", async () => {
		const dispatched: string[] = [];

		for (const verb of declaredVerbs()) {
			const p = probe();

			const handled = await executeBuiltinSlashCommand(`/advisor ${verb}`, p.runtime);

			expect(handled).toBe(true);
			const said = [...p.statuses, ...p.errors];
			if (!said.includes(USAGE_LINE) && (p.touched.length > 0 || said.length > 0)) dispatched.push(verb);
		}

		expect(dispatched).toEqual([...declaredVerbs()]);
	});

	it("routes status, configure and dump to the advisor entry points rather than a stub", async () => {
		const status = probe();
		const configure = probe();
		const dump = probe();

		await executeBuiltinSlashCommand("/advisor status", status.runtime);
		await executeBuiltinSlashCommand("/advisor configure", configure.runtime);
		await executeBuiltinSlashCommand("/advisor dump", dump.runtime);

		expect(status.touched).toEqual(["handleAdvisorStatusCommand"]);
		expect(configure.touched).toEqual(["showAdvisorConfigure"]);
		expect(dump.touched).toEqual(["handleAdvisorDumpCommand"]);
	});

	it("starts and stops the advisor for the session", async () => {
		const on = probe();
		const off = probe();

		await executeBuiltinSlashCommand("/advisor on", on.runtime);
		await executeBuiltinSlashCommand("/advisor off", off.runtime);

		expect(on.toggledWith).toEqual([true]);
		expect(off.toggledWith).toEqual([false]);
		expect(on.statuses).toEqual(["Advisor started for this session."]);
		expect(off.statuses).toEqual(["Advisor stopped for this session."]);
	});

	/**
	 * `/advisor on` reports the OUTCOME, not the request. Enabling the setting is half of it; a model
	 * must also resolve for the `advisor` role, and `setAdvisorEnabled` returns whether the runtime
	 * actually came up. Echoing "Advisor started" from the argument would claim a thing that did not
	 * happen and leave the user waiting for advice that cannot arrive.
	 */
	it("does not claim the advisor started when no model resolved for the role", async () => {
		const p = probe({ startsWhenEnabled: false });

		await executeBuiltinSlashCommand("/advisor on", p.runtime);

		expect(p.toggledWith).toEqual([true]);
		expect(p.statuses).toEqual([
			"Advisor enabled, but no model resolved for the advisor role — assign one with /model.",
		]);
	});

	/**
	 * The usage line has to name every verb that exists, or a declared subcommand becomes
	 * undiscoverable the moment someone mistypes. Derived from the declaration so adding a verb
	 * without extending the line fails here.
	 */
	it("answers an unknown verb with a usage line naming every declared subcommand", async () => {
		const p = probe();

		await executeBuiltinSlashCommand("/advisor frobnicate", p.runtime);

		expect(p.statuses).toEqual([USAGE_LINE]);
		for (const verb of declaredVerbs()) expect(USAGE_LINE).toContain(verb);
	});

	/**
	 * The headless surface answers the same question as the TUI one, and answered it one line
	 * shorter: it reported the state and stopped, leaving a text client at "Advisor is disabled."
	 * with nothing to act on. Both routes now read the next step from `advisorStatusNextStep`.
	 */
	it("tells a text client how to act on the status it just reported", async () => {
		const spec = lookupBuiltinSlashCommand("advisor");
		expect(spec?.handle).toBeDefined();
		const p = probe({ configured: false, startsWhenEnabled: false });
		const command: ParsedSlashCommand = { name: "advisor", args: "status", text: "/advisor status" };

		await spec?.handle?.(command, p.textRuntime);

		const said = p.printed.join("\n");
		expect(said).toContain("Advisor is disabled.");
		expect(said).toContain("/advisor on");
	});
});

describe("the advisor handlers report the session, not a removal notice", () => {
	function controller(shape: Partial<AdvisorSessionShape> = {}) {
		const p = probe(shape);
		const ctx = p.runtime.ctx as unknown as CommandControllerContext;
		return { probe: p, controller: new CommandController(ctx) };
	}

	/**
	 * The exact defect: three surfaces answered "Advisor/watchdog was removed from Veyyon" while the
	 * runtime was live. Driving the real controller is what makes this a behavior check — the text is
	 * whatever the session produced, so a future stub cannot pass it.
	 */
	it("status reports the running advisor and never claims the feature was removed", async () => {
		const active = controller();

		await active.controller.handleAdvisorStatusCommand();

		const said = active.probe.statuses.join("\n");
		expect(said).toContain("Advisor is enabled.");
		expect(said).not.toMatch(/was removed/i);
	});

	/**
	 * Off and "on but unresolved" need different fixes, so each carries its own instruction. A single
	 * generic line would send someone to `/settings` when the setting was already on.
	 */
	it("tells a disabled advisor and an unresolved one apart", async () => {
		const off = controller({ configured: false, startsWhenEnabled: false });
		const unresolved = controller({ configured: true, startsWhenEnabled: false });

		await off.controller.handleAdvisorStatusCommand();
		await unresolved.controller.handleAdvisorStatusCommand();

		expect(off.probe.statuses.join("\n")).toContain("/advisor on");
		expect(unresolved.probe.statuses.join("\n")).toContain("/model");
		expect(unresolved.probe.statuses.join("\n")).not.toContain("/advisor on");
	});

	it("refuses a dump when no advisor is running instead of copying nothing", () => {
		const none = controller({ transcript: null });

		none.controller.handleAdvisorDumpCommand();

		expect(none.probe.errors.join("\n")).toContain("No advisor is running");
		expect(none.probe.errors.join("\n")).not.toMatch(/was removed/i);
	});
});

describe("the advisor configure overlay is mounted, not announced as gone", () => {
	/**
	 * `showAdvisorConfigure` was the only entry point to a 577-line roster editor, and it answered
	 * with a status line saying the feature was gone. This drives the REAL selector controller, so a
	 * future stub fails here rather than passing a dispatch test that only proves the method was
	 * called.
	 */
	it("mounts the roster editor full-screen instead of reporting a removal", async () => {
		using tempDir = TempDir.createSync("@pi-advisor-configure-");
		const mounted: Array<{ component: unknown; options: Record<string, unknown> }> = [];
		const said: string[] = [];
		const ctx = {
			sessionManager: { getCwd: () => tempDir.path() },
			settings: Settings.isolated({}),
			session: {
				modelRegistry: { getAvailable: () => [] },
				scopedModels: [],
				agent: { state: { model: undefined } },
				getAdvisorAvailableToolNames: () => ["read", "grep", "glob"],
			},
			ui: {
				showOverlay: (component: unknown, options: Record<string, unknown>) => {
					mounted.push({ component, options });
					return { hide: () => {} };
				},
				setFocus: () => {},
				requestRender: () => {},
			},
			showStatus: (text: string) => {
				said.push(text);
			},
			showError: (text: string) => {
				said.push(text);
			},
		} as unknown as SelectorControllerContext;

		await new SelectorController(ctx).showAdvisorConfigure();

		expect(mounted).toHaveLength(1);
		expect(mounted[0]?.component).toBeInstanceOf(AdvisorConfigOverlayComponent);
		// The overlay paints from screen row 0 and hit-tests SGR mouse rows against that frame, so a
		// non-fullscreen mount would offset the frame and misroute every click in the roster.
		expect(mounted[0]?.options.fullscreen).toBe(true);
		expect(said.join("\n")).not.toMatch(/was removed/i);
	});
});
