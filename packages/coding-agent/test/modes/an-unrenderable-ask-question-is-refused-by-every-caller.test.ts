/**
 * An ask question the dialog cannot render reaches its caller as an ordinary
 * error, through every surface that can hand one over.
 *
 * WHY THIS SUITE EXISTS. `renderQuestionTitle` reads `question.question` with no
 * fallback and the dialog constructor reads `question.options.length`. A question
 * shaped `{id, header, options}` reached the header renderer and threw
 * `TypeError: undefined is not an object (evaluating 'text.replaceAll')` from
 * inside a render pass. A throw there is not a tool error and not a notice: it is
 * an uncaught exception, so the session died and took every live subagent with it.
 *
 * WHAT CLASS THIS CLOSES. Not "the reported question shape" and not "the dialog
 * component in isolation": every producer that can carry a question into the
 * dialog must get a named refusal instead of a dead process, and the modal
 * surface must be handed back so the next dialog still opens. The producers are
 * enumerated at run time rather than listed here — the controller's own method
 * names, the keys of the extension UI object the controller publishes to
 * extensions, and the tools whose schema declares a `questions` argument — so a
 * new ask surface turns this suite RED until someone drives it.
 *
 * The `ask` tool's schema is cross-checked against the dialog's guard the same
 * way: every field the guard refuses to render without is derived by probing the
 * guard, and the tool's own wire schema must declare each of them required.
 * Loosening one of them alone turns this RED.
 *
 * WHAT IT DOES NOT CATCH. With a collab host attached, `showAskDialog` races the
 * local dialog against a mirrored guest ask. The refusal reaches the caller (the
 * case below proves it, and proves it terminates while the guest request is still
 * pending), but `ExtensionUiController.showAskDialog` only aborts the remote side
 * on the resolve path, so a refusal leaves the guest's mirrored request pending
 * until the caller's own signal fires. That file belongs to another lane; this
 * suite pins the caller-visible contract that holds either way.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentTool, AgentToolContext } from "@veyyon/agent-core";
import { toolWireSchema } from "@veyyon/ai/utils/schema/wire";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import type {
	ExtensionAskDialogQuestion,
	ExtensionUIContext,
} from "@veyyon/coding-agent/extensibility/extensions/types";
import { AskDialogComponent } from "@veyyon/coding-agent/modes/components/ask-dialog";
import type { ExtensionUiControllerContext } from "@veyyon/coding-agent/modes/controllers/extension-ui-controller";
import { ExtensionUiController } from "@veyyon/coding-agent/modes/controllers/extension-ui-controller";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import { BUILTIN_TOOLS, HIDDEN_TOOLS, type ToolSession } from "@veyyon/coding-agent/tools";
import { AskTool, type AskToolInput } from "@veyyon/coding-agent/tools/ask";
import type { Component, OverlayHandle } from "@veyyon/tui";
import { setKeybindings } from "@veyyon/tui";
import { isRecord } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

/** The shape that killed the session: everything but the text that gets rendered. */
const REPORTED_QUESTION = {
	id: "dest",
	header: "Skill dest",
	options: [{ label: "oss-work profile skills" }, { label: "work + oss-work profiles" }],
	multi: false,
} as unknown as ExtensionAskDialogQuestion;

const WELL_FORMED_QUESTION: ExtensionAskDialogQuestion = {
	id: "dest",
	question: "Where should the skill go?",
	options: [{ label: "oss-work profile skills" }],
};

/** Every declared field of a question, so the guard can be probed one at a time. */
const MAXIMAL_QUESTION: Required<ExtensionAskDialogQuestion> = {
	id: "q1",
	question: "Which one?",
	header: "Pick",
	options: [{ label: "A", description: "first", preview: "preview text" }],
	multi: true,
	recommended: 0,
	preselected: ["A"],
};

interface MountedOverlay {
	component: Component;
	hidden: boolean;
	visible: boolean;
}

interface ControllerHarness {
	ctx: ExtensionUiControllerContext;
	controller: ExtensionUiController;
	overlays: MountedOverlay[];
	focused: unknown[];
}

function createHarness(collabHost?: unknown): ControllerHarness {
	const overlays: MountedOverlay[] = [];
	const focused: unknown[] = [];
	const editor = { id: "core-editor" };
	const editorContainer = {
		children: [] as unknown[],
		clear(): void {
			editorContainer.children = [];
		},
		addChild(child: unknown): void {
			editorContainer.children.push(child);
		},
	};
	const ui = {
		requestRender: (): void => {},
		setFocus: (component: unknown): void => {
			focused.push(component);
		},
		showOverlay: (component: Component): OverlayHandle => {
			const mounted: MountedOverlay = { component, hidden: false, visible: true };
			overlays.push(mounted);
			return {
				hide: (): void => {
					mounted.visible = false;
				},
				setHidden: (hidden: boolean): void => {
					mounted.hidden = hidden;
				},
				isHidden: (): boolean => mounted.hidden,
			};
		},
		terminal: { columns: 120, rows: 40 },
	};
	const ctx = {
		editor,
		editorContainer,
		ui,
		collabHost,
		focusActiveEditorArea: (): void => {},
		setToolUIContext: (): void => {},
		session: {},
	} as unknown as ExtensionUiControllerContext;
	return { ctx, controller: new ExtensionUiController(ctx), overlays, focused };
}

/** The extension UI object the controller publishes, captured at the seam extensions get it from. */
async function publishedExtensionUi(harness: ControllerHarness): Promise<ExtensionUIContext> {
	let captured: ExtensionUIContext | undefined;
	const ctx = harness.ctx as unknown as { setToolUIContext: (ui: ExtensionUIContext, enabled: boolean) => void };
	ctx.setToolUIContext = (ui: ExtensionUIContext): void => {
		captured = ui;
	};
	await harness.controller.initHooksAndCustomTools();
	if (!captured) throw new Error("initHooksAndCustomTools did not publish a UI context");
	return captured;
}

/**
 * Fields the dialog's guard refuses to open without, derived by probing the real
 * constructor rather than restating a table. Anything the guard stops rejecting,
 * or starts rejecting, moves this set.
 */
function fieldsTheDialogRequires(): string[] {
	const required: string[] = [];
	for (const field of Object.keys(MAXIMAL_QUESTION)) {
		const shaped: Record<string, unknown> = structuredClone(MAXIMAL_QUESTION);
		delete shaped[field];
		try {
			new AskDialogComponent([shaped as unknown as ExtensionAskDialogQuestion], {
				onSubmit: () => {},
				onCancel: () => {},
				onPrompt: async () => undefined,
			}).dispose();
		} catch {
			required.push(field);
		}
	}
	return required.sort();
}

/** A tool session complete enough to construct every registered tool. */
function sweepSession(): ToolSession {
	return makeToolSession({
		hasUI: true,
		settings: {
			get: (setting: string) => (setting === "ask.notify" ? "off" : undefined),
			getAgentDir: () => path.join(os.tmpdir(), "veyyon-ask-entry-points"),
		},
	});
}

/**
 * What the caller ends up holding, under a deadline.
 *
 * A dialog that is not refused is not merely wrong, it OPENS: the promise then
 * never settles until somebody answers it, and an assertion awaiting it hangs
 * the suite instead of failing it. Bounding it here turns "the refusal never
 * came" into a named failure, which is also the termination property this class
 * needs — the caller of a bad question must always get an answer back.
 */
async function outcomeOf(call: Promise<unknown> | undefined): Promise<string> {
	if (!call) return "no call was made";
	const settled = call.then(
		value => `resolved with ${JSON.stringify(value ?? null)}`,
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
	const timedOut = "the dialog opened and waited for an answer instead of refusing";
	return await Promise.race([settled, sleep(2_000, timedOut, { ref: false })]);
}

describe("an unrenderable ask question is refused by every caller", () => {
	const crashes: string[] = [];
	const onUncaught = (error: unknown): void => {
		crashes.push(`uncaughtException: ${error instanceof Error ? error.message : String(error)}`);
	};
	const onUnhandled = (reason: unknown): void => {
		crashes.push(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
	};

	beforeAll(async () => {
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("Failed to load dark theme");
		setThemeInstance(dark);
	});

	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		crashes.length = 0;
		process.on("uncaughtException", onUncaught);
		process.on("unhandledRejection", onUnhandled);
	});

	afterEach(async () => {
		// A refusal routed as an exception nobody catches is the original bug in a
		// new costume, so every case ends by proving the process stayed clean.
		await Promise.resolve();
		process.removeListener("uncaughtException", onUncaught);
		process.removeListener("unhandledRejection", onUnhandled);
		expect(crashes).toEqual([]);
	});

	/**
	 * The surfaces are read off the running objects, not written down. A second
	 * controller method or a second extension-API key whose name mentions "ask"
	 * fails here until it is driven below.
	 */
	it("covers every ask surface the controller and the extension API publish", async () => {
		const harness = createHarness();
		const controllerSurfaces = Object.getOwnPropertyNames(ExtensionUiController.prototype)
			.filter(name => /ask/i.test(name))
			.sort();
		expect(controllerSurfaces).toEqual(["showAskDialog"]);

		const ui = await publishedExtensionUi(harness);
		const publishedSurfaces = Object.keys(ui)
			.filter(name => /ask/i.test(name))
			.sort();
		expect(publishedSurfaces).toEqual(["askDialog"]);
		expect(typeof ui.askDialog).toBe("function");
	});

	it("covers every registered tool that takes questions", async () => {
		const session = sweepSession();
		const askTools: string[] = [];
		const unconstructable: string[] = [];
		for (const [name, factory] of Object.entries({ ...BUILTIN_TOOLS, ...HIDDEN_TOOLS })) {
			let tool: AgentTool | null = null;
			try {
				tool = await factory(session);
			} catch {
				unconstructable.push(name);
				continue;
			}
			if (!tool) continue;
			const properties = toolWireSchema(tool).properties;
			if (isRecord(properties) && "questions" in properties) askTools.push(tool.name);
		}
		// A tool the sweep cannot build is a hole in the sweep, not a tool that is safe.
		expect(unconstructable).toEqual([]);
		expect(askTools.sort()).toEqual(["ask"]);
	});

	it("refuses through the controller, names the field and the question, and hands back the modal surface", async () => {
		const harness = createHarness();
		expect(await outcomeOf(harness.controller.showAskDialog([REPORTED_QUESTION]))).toMatch(
			/Ask dialog question 0 \(dest\) has no question text \(missing\)/,
		);
		// Nothing was mounted and nothing took focus, so no render pass ever ran.
		expect(harness.overlays).toEqual([]);
		expect(harness.focused).toEqual([]);

		// The surface is free: a following dialog presents immediately instead of
		// queueing behind a dialog that never opened.
		const pending = harness.controller.showAskDialog([WELL_FORMED_QUESTION]);
		expect(harness.overlays).toHaveLength(1);
		expect(harness.overlays[0]?.visible).toBe(true);
		harness.overlays[0]?.component.handleInput?.("\x1b");
		expect(await outcomeOf(pending)).toBe("resolved with null");
		expect(harness.overlays[0]?.visible).toBe(false);
	});

	it("refuses through the extension UI askDialog an extension actually calls", async () => {
		const harness = createHarness();
		const ui = await publishedExtensionUi(harness);
		expect(await outcomeOf(ui.askDialog?.([REPORTED_QUESTION]))).toMatch(
			/Ask dialog question 0 \(dest\) has no question text \(missing\)/,
		);
		expect(harness.overlays).toEqual([]);
	});

	it("refuses every unrenderable shape through the published API, not only the reported one", async () => {
		const harness = createHarness();
		const ui = await publishedExtensionUi(harness);
		const shapes: Array<[string, unknown]> = [
			["no questions", []],
			["not an array", { id: "q", question: "?", options: [] }],
			["null question", [null]],
			["string question", ["Which one?"]],
			["no id", [{ question: "?", options: [] }]],
			["blank question text", [{ id: "q", question: "   ", options: [] }]],
			["options not an array", [{ id: "q", question: "?", options: "A, B" }]],
			["null inside options", [{ id: "q", question: "?", options: [null] }]],
			["option with no label", [{ id: "q", question: "?", options: [{ description: "d" }] }]],
			["non-string question", [{ id: "q", question: 7, options: [] }]],
			["nested null option label", [{ id: "q", question: "?", options: [{ label: null }] }]],
		];

		const accepted: string[] = [];
		for (const [label, questions] of shapes) {
			const outcome = await outcomeOf(ui.askDialog?.(questions as ExtensionAskDialogQuestion[]));
			if (!outcome.startsWith("Ask dialog")) accepted.push(`${label}: ${outcome}`);
		}
		expect(accepted).toEqual([]);
		expect(harness.overlays).toEqual([]);
	});

	it("refuses through the ask tool as an ordinary tool error rather than a dead session", async () => {
		const harness = createHarness();
		const ui = await publishedExtensionUi(harness);
		const tool = new AskTool(sweepSession());
		const context = {
			hasUI: true,
			ui,
			abort: () => {},
		} as unknown as AgentToolContext;

		const failure = await outcomeOf(
			tool.execute(
				"call-1",
				{ questions: [REPORTED_QUESTION] } as unknown as AskToolInput,
				undefined,
				undefined,
				context,
			),
		);
		expect(failure).toMatch(/Ask dialog question 0 \(dest\) has no question text \(missing\)/);
		expect(harness.overlays).toEqual([]);
	});

	/**
	 * The tool's schema and the dialog's guard are two contracts over one shape,
	 * and the crash happened because a caller satisfied one and not the other.
	 * Both are read at run time, so loosening either alone fails here.
	 */
	it("requires in the ask tool's own schema every field the dialog refuses to open without", async () => {
		const tool = new AskTool(sweepSession());
		const questions = toolWireSchema(tool).properties;
		if (!isRecord(questions)) throw new Error("ask schema has no properties");
		const list = questions.questions;
		if (!isRecord(list)) throw new Error("ask schema declares no questions argument");
		const item = list.items;
		if (!isRecord(item)) throw new Error("ask schema declares no question item shape");
		const required = Array.isArray(item.required) ? item.required.filter(key => typeof key === "string") : [];

		const dialogRequires = fieldsTheDialogRequires();
		expect(dialogRequires).toEqual(["id", "options", "question"]);
		expect(dialogRequires.filter(field => !required.includes(field))).toEqual([]);
	});

	/**
	 * With a collab host the local dialog is raced against a mirrored guest ask.
	 * The refusal has to reach the caller and it has to terminate: the guest
	 * request here never settles, so a refusal that waited for the race would
	 * hang this test rather than fail it.
	 */
	it("refuses with a collab host attached and does not wait for the guest", async () => {
		const guestRequests: unknown[] = [];
		const host = {
			requestGuestUi: (request: unknown): Promise<never> => {
				guestRequests.push(request);
				const { promise } = Promise.withResolvers<never>();
				return promise;
			},
		};
		const harness = createHarness(host);

		expect(await outcomeOf(harness.controller.showAskDialog([REPORTED_QUESTION]))).toMatch(
			/Ask dialog question 0 \(dest\) has no question text \(missing\)/,
		);
		expect(harness.overlays).toEqual([]);
		// The collab branch really ran: the guest was asked before the local dialog
		// refused, which is what makes the termination assertion above meaningful.
		expect(guestRequests).toHaveLength(1);
	});

	it("still opens for a well-formed question, so the guard is not refusing everything", async () => {
		const harness = createHarness();
		const ui = await publishedExtensionUi(harness);

		const pending = ui.askDialog?.([WELL_FORMED_QUESTION]);
		expect(harness.overlays).toHaveLength(1);
		const rendered = harness.overlays[0]?.component.render(100).join("\n") ?? "";
		expect(Bun.stripANSI(rendered)).toContain("Where should the skill go?");
		harness.overlays[0]?.component.handleInput?.("\x1b");
		expect(await outcomeOf(pending)).toBe("resolved with null");
	});
});
