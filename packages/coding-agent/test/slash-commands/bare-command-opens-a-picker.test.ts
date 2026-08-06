import { beforeAll, describe, expect, it, vi } from "bun:test";
import { SubcommandPickerComponent } from "@veyyon/coding-agent/modes/components/subcommand-picker";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { executeAcpBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/acp-builtins";
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	type BuiltinSlashCommandDeclaration,
} from "@veyyon/coding-agent/slash-commands/builtin-declarations";
import { executeBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime, SubcommandDef, TuiSlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

/**
 * `docs/internal/slash-command-internals.md` section 9: a command that declares `subcommands` must
 * never silently behave as one of them. Bare `/account` printed the status block, which is what
 * `/account status` does, while seven other subcommands existed and nothing said so.
 *
 * The defect is invisible from inside a handler. `if (!verb || verb === "status")` reads as
 * ordinary code, and only the declaration says `status` is a subcommand, so catching it needs a
 * comparison across two files that no reviewer repeats on every change. This file does it.
 *
 * Everything here drives the real dispatchers. Nothing reads the source of `builtin-registry.ts`:
 * a text scan would pass while the behavior was wrong and fail on a rename that changed nothing.
 */

type SubcommandBearing = BuiltinSlashCommandDeclaration & { subcommands: readonly SubcommandDef[] };

/** The `as const` export narrows to a union of literal shapes; the rule is about the declared type. */
const ALL_DECLARATIONS: readonly BuiltinSlashCommandDeclaration[] = BUILTIN_SLASH_COMMAND_DECLARATIONS;

const SUBCOMMAND_BEARING = ALL_DECLARATIONS.filter(
	(declaration): declaration is SubcommandBearing =>
		declaration.subcommands !== undefined && declaration.subcommands.length > 0,
);

/** Everything the rule applies to: distinct bare forms are waived, and the waiver is checked separately. */
const PICKER_COMMANDS = SUBCOMMAND_BEARING.filter(declaration => declaration.bareAction !== "distinct");

/** Members the dispatcher itself touches on the way to opening a picker, and nothing else. */
const REACHABLE_WHILE_OPENING_A_PICKER: Record<string, true> = {
	collabGuest: true,
	editor: true,
	ui: true,
	showSubcommandPicker: true,
};

interface PickerOpened {
	commandName: string;
	subcommands: readonly SubcommandDef[];
	choose: (subcommand: SubcommandDef) => void;
}

/**
 * A context that can open a picker and can do nothing else.
 *
 * Every other member throws by name. That is what makes this behavioral rather than a shape check:
 * if the bare path runs the handler, the handler reaches for `session` or `showStatus` and the test
 * fails saying which one, instead of quietly asserting that a picker callback was not recorded.
 */
function pickerProbe(): { opened: PickerOpened[]; editorText: string[]; runtime: TuiSlashCommandRuntime } {
	const opened: PickerOpened[] = [];
	const editorText: string[] = [];
	const members: Record<string, unknown> = {
		collabGuest: undefined,
		editor: { setText: (text: string) => editorText.push(text) },
		ui: { requestRender: () => {} },
		showSubcommandPicker: (
			commandName: string,
			subcommands: readonly SubcommandDef[],
			choose: (subcommand: SubcommandDef) => void,
		) => {
			opened.push({ commandName, subcommands, choose });
		},
	};
	const ctx = new Proxy(members, {
		get(target, property) {
			if (typeof property === "string" && REACHABLE_WHILE_OPENING_A_PICKER[property] !== true) {
				throw new Error(`bare invocation reached ctx.${property}: a handler ran instead of the picker opening`);
			}
			return target[property as string];
		},
	}) as unknown as InteractiveModeContext;
	return { opened, editorText, runtime: { ctx } };
}

/** A text-mode runtime whose session surface throws, so a handler that runs is caught by name. */
function textProbe(): { said: string[]; runtime: SlashCommandRuntime } {
	const said: string[] = [];
	const forbidden = (label: string) =>
		new Proxy(
			{},
			{
				get(_target, property) {
					throw new Error(`bare invocation reached ${label}.${String(property)}: a handler ran`);
				},
			},
		);
	return {
		said,
		runtime: {
			session: forbidden("session"),
			sessionManager: forbidden("sessionManager"),
			settings: forbidden("settings"),
			cwd: "/tmp",
			output: (text: string) => {
				said.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		} as unknown as SlashCommandRuntime,
	};
}

describe("a bare command that has subcommands", () => {
	/**
	 * The rule itself, over every declaration that carries `subcommands`.
	 *
	 * Locks out the whole class: `/account` -> status, `/permissions` -> status, `/usage` -> show,
	 * `/memory` -> view, and any future command that grows a hidden default. A new command either
	 * opts into the distinct-bare-form exception on purpose or it gets the picker.
	 */
	it.each(PICKER_COMMANDS.map(declaration => [declaration.name, declaration] as const))(
		"/%s opens the picker rather than running one of its subcommands",
		async (_name, declaration) => {
			const probe = pickerProbe();

			const handled = await executeBuiltinSlashCommand(`/${declaration.name}`, probe.runtime);

			expect(handled).toBe(true);
			expect(probe.opened).toHaveLength(1);
			expect(probe.opened[0]?.commandName).toBe(declaration.name);
			expect(probe.opened[0]?.subcommands.map(sub => sub.name)).toEqual(
				declaration.subcommands.map(sub => sub.name),
			);
		},
	);

	/**
	 * The text path has no picker to open, so it must print the list. Without this the rule would
	 * hold in the terminal and an ACP or `-p` client would still get one of eight subcommands with
	 * no sign the others existed.
	 */
	it.each(
		PICKER_COMMANDS.filter(declaration => declaration.textMode === true).map(
			declaration => [declaration.name, declaration] as const,
		),
	)("/%s lists its subcommands in text mode instead of running one", async (_name, declaration) => {
		const probe = textProbe();

		const result = await executeAcpBuiltinSlashCommand(`/${declaration.name}`, probe.runtime);

		expect(result).toEqual({ consumed: true });
		const listed = probe.said.join("\n");
		for (const subcommand of declaration.subcommands) {
			expect(listed).toContain(`/${declaration.name} ${subcommand.name}`);
			expect(listed).toContain(subcommand.description);
		}
	});

	/**
	 * The picker is a way in, never a second implementation. Choosing `info` must reach the same
	 * place typing `/session info` reaches, so the two invocations are compared against one spy.
	 * If the picker ever grew its own copy of a handler this fails, which is the point.
	 */
	it("runs the chosen subcommand through the path typing it would take", async () => {
		const handleSessionCommand = vi.fn(async () => {});
		const setText = vi.fn();
		const ctx = {
			editor: { setText },
			ui: { requestRender: vi.fn() },
			handleSessionCommand,
			showSubcommandPicker: (
				_name: string,
				subcommands: readonly SubcommandDef[],
				choose: (subcommand: SubcommandDef) => void,
			) => {
				const info = subcommands.find(sub => sub.name === "info");
				if (info) choose(info);
			},
		} as unknown as InteractiveModeContext;

		await executeBuiltinSlashCommand("/session", { ctx });
		const viaPicker = handleSessionCommand.mock.calls.length;
		await executeBuiltinSlashCommand("/session info", { ctx });

		expect(viaPicker).toBe(1);
		expect(handleSessionCommand).toHaveBeenCalledTimes(2);
	});

	/**
	 * `/account switch [provider]` and `/account name <text>` take an argument, and running either
	 * with an empty one is not what the operator picked: a bare `/account name` renames nothing and
	 * reports a usage error. Picking such an entry prefills the editor and waits for the argument.
	 */
	it("prefills the editor for a subcommand that declares a usage instead of running it empty", async () => {
		const setText = vi.fn();
		const showAccountManager = vi.fn(async () => {});
		const ctx = {
			editor: { setText },
			ui: { requestRender: vi.fn() },
			showAccountManager,
			showSubcommandPicker: (
				_name: string,
				subcommands: readonly SubcommandDef[],
				choose: (subcommand: SubcommandDef) => void,
			) => {
				const target = subcommands.find(sub => sub.name === "switch");
				if (target) choose(target);
			},
		} as unknown as InteractiveModeContext;

		await executeBuiltinSlashCommand("/account", { ctx });

		expect(setText).toHaveBeenLastCalledWith("/account switch ");
		expect(showAccountManager).not.toHaveBeenCalled();
	});

	/**
	 * A bare command must be able to end in nothing happening. Dismissing the picker without
	 * choosing runs no subcommand, which is what makes the picker safe to open on a command whose
	 * entries log accounts out or start a live share.
	 */
	it("runs nothing when the picker is dismissed", async () => {
		const setText = vi.fn();
		const showAccountManager = vi.fn(async () => {});
		const ctx = {
			editor: { setText },
			ui: { requestRender: vi.fn() },
			showAccountManager,
			showSubcommandPicker: () => {},
		} as unknown as InteractiveModeContext;

		const handled = await executeBuiltinSlashCommand("/account", { ctx });

		expect(handled).toBe(true);
		expect(showAccountManager).not.toHaveBeenCalled();
		expect(setText).toHaveBeenCalledWith("");
	});
});

describe("the picker card", () => {
	beforeAll(async () => {
		await initTheme();
	});

	const SUBCOMMANDS: SubcommandDef[] = [
		{ name: "status", description: "Show the account each provider is serving this session with" },
		{ name: "manager", description: "Open the account manager" },
		{ name: "switch", description: "Open the account manager focused on one provider", usage: "[provider]" },
	];

	function card(): {
		component: SubcommandPickerComponent;
		chosen: SubcommandDef[];
		cancelled: number[];
	} {
		const chosen: SubcommandDef[] = [];
		const cancelled: number[] = [];
		const component = new SubcommandPickerComponent(
			"account",
			SUBCOMMANDS,
			subcommand => chosen.push(subcommand),
			() => cancelled.push(1),
		);
		return { component, chosen, cancelled };
	}

	/**
	 * The down arrow moves the selection. This is the affordance the operator reaches for first,
	 * and a card that only answered to a letter key or to the mouse would be the same dead end the
	 * account manager was: the entry is on screen and the arrow does not reach it.
	 */
	it("moves the selection with the down arrow before enter commits it", () => {
		const { component, chosen } = card();
		component.render(100);

		component.handleInput("\x1b[B");
		component.handleInput("\r");

		expect(chosen).toEqual([SUBCOMMANDS[1]]);
	});

	/** The up arrow moves back, so the selection is navigable in both directions rather than one. */
	it("moves the selection back with the up arrow", () => {
		const { component, chosen } = card();
		component.render(100);

		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[A");
		component.handleInput("\r");

		expect(chosen).toEqual([SUBCOMMANDS[1]]);
	});

	/**
	 * A click on a row selects that row. The main pane of the account manager was not clickable and
	 * the operator found out by clicking it, so a new card ships with the pointer wired.
	 */
	it("selects the row that was clicked", () => {
		const { component, chosen } = card();
		const frame = component.render(100);
		const row = frame.findIndex(line => line.includes("manager"));
		expect(row).toBeGreaterThan(0);
		const col = frame[row].indexOf("manager");

		component.handleInput(`\x1b[<0;${col + 1};${row + 1}M`);

		expect(chosen).toEqual([SUBCOMMANDS[1]]);
	});

	/** Escape closes and chooses nothing, so opening a picker is never a commitment. */
	it("closes on escape without choosing anything", () => {
		const { component, chosen, cancelled } = card();
		component.render(100);

		component.handleInput("\x1b");

		expect(cancelled).toHaveLength(1);
		expect(chosen).toEqual([]);
	});

	/**
	 * Each row carries the description, and a subcommand that takes an argument shows its shape.
	 * `SelectItem.hint` only feeds the fuzzy filter and is never painted, so a usage put there would
	 * be invisible on the row it describes: this pins it on the visible label instead.
	 */
	it("shows each subcommand's description and the argument shape it takes", () => {
		const { component } = card();

		const rows = component.render(100).map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));

		expect(rows.find(row => row.includes("manager"))).toContain("Open the account manager");
		expect(rows.find(row => row.includes("switch"))).toContain("switch [provider]");
	});
});

describe("the distinct-bare-form exception", () => {
	/**
	 * `bareAction: "distinct"` is a waiver from the rule, and a waiver nothing checks is a waiver
	 * anyone can take. The dispatcher cannot tell an honest switch from a hidden default dressed as
	 * one, so the decision is reviewed here instead: every waiver in the declarations must appear
	 * below with the reason it is not a hidden default. Adding a waiver without writing down why
	 * fails this, which is the whole point of the register.
	 */
	it("waives only the commands whose bare form was reviewed and written down", () => {
		const reviewed: Record<string, string> = {
			setup: "bare opens the setup wizard, which is more than its single `providers` step",
			goal: "bare enters goal mode or opens its menu, which is none of set/show/clear",
			fast: "bare flips the priority tier",
			yolo: "bare flips the approval bypass",
			secret: "bare opens the masked value field; the grammar is deliberately verbless",
			browser: "bare flips headless against visible",
			todo: "bare renders the list; every subcommand mutates it",
			compact: "bare compacts with the default mode; the subcommands are the other modes",
			plugins: "bare lists plugins, and `list` is a synonym for it, not a hidden branch",
		};

		const waived = SUBCOMMAND_BEARING.filter(declaration => declaration.bareAction === "distinct")
			.map(declaration => declaration.name)
			.sort();

		expect(waived).toEqual(Object.keys(reviewed).sort());
	});

	/**
	 * `/yolo`, `/fast`, and `/browser` are switches, not hidden defaults, and a picker in front of a
	 * switch costs a keystroke on the most common action. They are the regression most likely to
	 * follow from a rule written about everything else, so their bare form is pinned here too.
	 */
	it("leaves bare /yolo flipping the approval bypass", async () => {
		let bypassed = false;
		const said: string[] = [];
		const runtime = {
			session: {
				isApprovalBypassed: () => bypassed,
				setApprovalBypass: (value: boolean) => {
					bypassed = value;
				},
			},
			output: (text: string) => said.push(text),
		} as unknown as SlashCommandRuntime;

		await executeAcpBuiltinSlashCommand("/yolo", runtime);

		expect(bypassed).toBe(true);
		expect(said[0]).toContain("Full permission bypass ON");
	});

	it("leaves bare /fast flipping the priority tier", async () => {
		const toggleFastMode = vi.fn(() => true);
		const said: string[] = [];
		const runtime = {
			session: { toggleFastMode },
			output: (text: string) => said.push(text),
		} as unknown as SlashCommandRuntime;

		await executeAcpBuiltinSlashCommand("/fast", runtime);

		expect(toggleFastMode).toHaveBeenCalledTimes(1);
		expect(said[0]).toContain("enabled");
	});

	it("leaves bare /browser flipping headless mode", async () => {
		const values: Record<string, unknown> = { "browser.enabled": true, "browser.headless": false };
		const said: string[] = [];
		const runtime = {
			session: { getToolByName: () => undefined },
			settings: {
				get: (key: string) => values[key],
				set: (key: string, value: unknown) => {
					values[key] = value;
				},
			},
			output: (text: string) => said.push(text),
		} as unknown as SlashCommandRuntime;

		await executeAcpBuiltinSlashCommand("/browser", runtime);

		expect(values["browser.headless"]).toBe(true);
		expect(said[0]).toBe("Browser mode: headless");
	});
});
