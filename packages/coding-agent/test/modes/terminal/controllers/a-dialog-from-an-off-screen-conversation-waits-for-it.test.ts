/**
 * A dialog from an off-screen conversation waits for it.
 *
 * WHY THIS SUITE EXISTS. A room runs several conversations in one terminal and
 * shows one. Each conversation's tools and extensions hold a UI context bound
 * to it (`ExtensionUiController.bindSession`). Without a gate, a question asked
 * by a conversation the operator is not looking at is drawn over the one they
 * are, and the answer reads as answering the wrong conversation; a status,
 * widget, title or editor write from it repaints a screen that belongs to
 * someone else.
 *
 * THE CLASS CLOSED. Every member of the bound context is enumerated from the
 * context object's own keys at run time (and the keys of its `terminal`
 * capability) and must have a decision recorded here, so a member added to
 * `ExtensionUIContext` fails this suite until someone decides how an
 * off-screen conversation uses it. Every dialog member, called by a
 * conversation off screen: does not present, is counted in `waitingDialogs`,
 * fires the waiting listener, and presents once that conversation is on
 * screen and attached; its abort signal settles it to the fallback, drops the
 * count, and the abandoned question is never raised later. Every chrome
 * member is dropped from off screen and reaches the terminal from on screen,
 * decided at call time rather than at bind time.
 *
 * The controller is real. What stands in for the terminal is the controller's
 * own presentation methods, spied so a presented dialog resolves at once, and
 * the context fields those methods write through. The two conversations are
 * identities only: the gate compares `ctx.session` against the bound session
 * and reads nothing else of it, and an absent extension runner is the case
 * `bindSession` takes when no extension is loaded.
 *
 * NOT CAUGHT. That a presented dialog draws correctly (the dialog suites own
 * that). That the host calls `sessionAttached` on every switch: the room
 * controller suite drives `attachMainSession`, which the interactive mode
 * wires to it. `terminal.custom` takes no signal, so an abandoned custom
 * screen waits until its conversation comes back.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { ExtensionUIContext, TerminalInputHandler } from "@veyyon/coding-agent/extensibility/extensions";
import { CustomEditor } from "@veyyon/coding-agent/modes/terminal/components/composer/custom-editor";
import {
	ExtensionUiController,
	type ExtensionUiControllerContext,
} from "@veyyon/coding-agent/modes/terminal/controllers/extension-ui-controller";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { getEditorTheme, initTheme } from "@veyyon/coding-agent/theme/theme";
import * as titleGenerator from "@veyyon/coding-agent/utils/title-generator";
import { Container } from "@veyyon/tui";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

interface Harness {
	controller: ExtensionUiController;
	/** The launch conversation's context: on screen until `bring(b)`. */
	aUi: ExtensionUIContext;
	/** The other conversation's context, bound through `bindSession`. */
	bUi: ExtensionUIContext;
	a: AgentSession;
	b: AgentSession;
	editor: CustomEditor;
	/** Chrome writes that reached the terminal, as `member:tag`. */
	log: string[];
	/** Deliver raw terminal input to every listener registered with the terminal. */
	type(data: string): void;
	/** Put `session` on screen the way the host does: re-point `ctx.session`, then attach. */
	bring(session: AgentSession): void;
	/** An editor factory tagged so the call that sent it is named when it reaches the terminal. */
	editorFactory(tag: string): () => CustomEditor;
}

async function harness(): Promise<Harness> {
	const a = { extensionRunner: undefined } as unknown as AgentSession;
	const b = { extensionRunner: undefined } as unknown as AgentSession;
	const editor = new CustomEditor(getEditorTheme());
	const log: string[] = [];
	const inputListeners: TerminalInputHandler[] = [];
	const factoryTags = new Map<unknown, string>();
	let aUi: ExtensionUIContext | undefined;
	let bUi: ExtensionUIContext | undefined;
	const ctx = {
		editor,
		session: a,
		ui: {
			requestRender: () => {},
			addInputListener: (handler: TerminalInputHandler) => {
				inputListeners.push(handler);
				return () => {};
			},
		},
		toolOutputExpanded: false,
		setToolUIContext: (context: ExtensionUIContext) => {
			aUi = context;
		},
		setToolNotifier: () => {},
		setWorkingMessage: (message?: string) => {
			log.push(`setWorkingMessage:${message}`);
		},
		setEditorComponent: (factory: unknown) => {
			log.push(`terminal.setEditorComponent:${factoryTags.get(factory)}`);
		},
		setToolsExpanded: (expanded: boolean) => {
			log.push(`setToolsExpanded:${expanded}`);
		},
		addAutocompleteProvider: () => {
			log.push("addAutocompleteProvider:");
		},
	};
	const controller = new ExtensionUiController(ctx as unknown as ExtensionUiControllerContext);
	// The terminal's presentation, in place of drawing: each records what reached it.
	vi.spyOn(controller, "showHookNotify").mockImplementation(message => {
		log.push(`notify:${message}`);
	});
	vi.spyOn(controller, "setHookStatus").mockImplementation((_key, text) => {
		log.push(`setStatus:${text}`);
	});
	vi.spyOn(controller, "setHookWidget").mockImplementation(key => {
		log.push(`widget:${key}`);
	});
	vi.spyOn(titleGenerator, "setTerminalTitle").mockImplementation(title => {
		log.push(`setTitle:${title}`);
	});
	await controller.initHooksAndCustomTools();
	await controller.bindSession(b, {
		setToolUIContext: context => {
			bUi = context;
		},
		setToolNotifier: () => {},
	});
	if (!aUi || !bUi) throw new Error("Expected both conversations to be handed a UI context");
	return {
		controller,
		aUi,
		bUi,
		a,
		b,
		editor,
		log,
		type: data => {
			for (const listener of inputListeners) listener(data);
		},
		bring: session => {
			ctx.session = session;
			controller.sessionAttached(session);
		},
		editorFactory: tag => {
			const factory = () => new CustomEditor(getEditorTheme());
			factoryTags.set(factory, tag);
			return factory;
		},
	};
}

// ---------------------------------------------------------------- decisions

/** A dialog member: how to call it, what the terminal answers once it is shown, and what an abort settles it to. */
interface DialogDecision {
	/** Replace the terminal's presentation of this dialog with an immediate answer; returns how many were shown. */
	present(controller: ExtensionUiController): () => number;
	call(ui: ExtensionUIContext, signal?: AbortSignal): Promise<unknown>;
	answer: unknown;
	/** The value a cancelled wait resolves with; absent for a member that takes no signal. */
	fallback?: { value: unknown };
}

const DIALOGS: Record<string, DialogDecision> = {
	select: {
		present: c => {
			const spy = vi.spyOn(c, "showCollabAwareSelector").mockResolvedValue("picked");
			return () => spy.mock.calls.length;
		},
		call: (ui, signal) => ui.select("Pick one", ["picked", "other"], { signal }),
		answer: "picked",
		fallback: { value: undefined },
	},
	confirm: {
		present: c => {
			const spy = vi.spyOn(c, "showHookConfirm").mockResolvedValue(true);
			return () => spy.mock.calls.length;
		},
		call: (ui, signal) => ui.confirm("Proceed?", "It writes a file", { signal }),
		answer: true,
		fallback: { value: false },
	},
	input: {
		present: c => {
			const spy = vi.spyOn(c, "showHookInput").mockResolvedValue("typed");
			return () => spy.mock.calls.length;
		},
		call: (ui, signal) => ui.input("Name", "placeholder", { signal }),
		answer: "typed",
		fallback: { value: undefined },
	},
	askDialog: {
		present: c => {
			const spy = vi.spyOn(c, "showAskDialog").mockResolvedValue({ kind: "chat" });
			return () => spy.mock.calls.length;
		},
		call: (ui, signal) => {
			if (!ui.askDialog) throw new Error("The terminal context offers askDialog");
			return ui.askDialog([], { signal });
		},
		answer: { kind: "chat" },
		fallback: { value: undefined },
	},
	editor: {
		present: c => {
			const spy = vi.spyOn(c, "showCollabAwareEditor").mockResolvedValue("edited");
			return () => spy.mock.calls.length;
		},
		call: (ui, signal) => ui.editor("Edit", "prefill", { signal }),
		answer: "edited",
		fallback: { value: undefined },
	},
	"terminal.custom": {
		present: c => {
			const spy = vi.spyOn(c, "showHookCustom").mockImplementation(async () => "custom-result" as never);
			return () => spy.mock.calls.length;
		},
		call: ui => {
			if (!ui.terminal) throw new Error("The terminal context offers a terminal capability");
			return ui.terminal.custom(() => new Container());
		},
		answer: "custom-result",
	},
};

/** A chrome member: a write to the screen, which must reach it only from the conversation on it. */
interface ChromeDecision {
	invoke(h: Harness, ui: ExtensionUIContext, tag: string): void;
	reached(h: Harness, tag: string): boolean;
}

function logged(member: string): ChromeDecision["reached"] {
	return (h, tag) => h.log.includes(`${member}:${tag}`);
}

const CHROME: Record<string, ChromeDecision> = {
	notify: { invoke: (_h, ui, tag) => ui.notify(tag, "info"), reached: logged("notify") },
	setStatus: { invoke: (_h, ui, tag) => ui.setStatus("room-test", tag), reached: logged("setStatus") },
	setWorkingMessage: { invoke: (_h, ui, tag) => ui.setWorkingMessage(tag), reached: logged("setWorkingMessage") },
	setWidget: { invoke: (_h, ui, tag) => ui.setWidget(tag, ["row"]), reached: logged("widget") },
	setTitle: { invoke: (_h, ui, tag) => ui.setTitle(tag), reached: logged("setTitle") },
	setEditorText: { invoke: (_h, ui, tag) => ui.setEditorText(tag), reached: (h, tag) => h.editor.getText() === tag },
	pasteToEditor: {
		invoke: (h, ui, tag) => {
			h.editor.setText("");
			ui.pasteToEditor(tag);
		},
		reached: (h, tag) => h.editor.getText().includes(tag),
	},
	"terminal.setWidgetComponent": {
		invoke: (_h, ui, tag) => ui.terminal?.setWidgetComponent(tag, () => new Container()),
		reached: logged("widget"),
	},
	"terminal.setEditorComponent": {
		invoke: (h, ui, tag) => ui.terminal?.setEditorComponent(h.editorFactory(tag)),
		reached: logged("terminal.setEditorComponent"),
	},
	onTerminalInput: {
		// The registration always reaches the terminal; the gate is on delivery.
		invoke: (h, ui, tag) => {
			ui.onTerminalInput(() => {
				h.log.push(`onTerminalInput:${tag}`);
				return undefined;
			});
			h.type("x");
		},
		reached: logged("onTerminalInput"),
	},
};

/** Reads the conversation off screen gets an empty answer to, rather than another conversation's state. */
const SCREEN_READS = ["getEditorText"];

/**
 * Members that are not screen state of one conversation and pass through from
 * any conversation: the theme, autocomplete stacking, the tool expansion
 * toggle, and the static presentation flag.
 */
const SHARED = [
	"addAutocompleteProvider",
	"getAllThemes",
	"getTheme",
	"getToolsExpanded",
	"setTheme",
	"setToolsExpanded",
	"theme",
	"timeoutStartsOnPresentation",
];

function membersOf(ui: ExtensionUIContext): string[] {
	const top = Object.keys(ui).filter(key => key !== "terminal");
	const terminal = ui.terminal ? Object.keys(ui.terminal).map(key => `terminal.${key}`) : [];
	return [...top, ...terminal].sort();
}

// ---------------------------------------------------------------- the sweep

describe("every member of the bound context has a recorded decision", () => {
	it("the context each conversation holds has exactly the members decided here", async () => {
		const h = await harness();
		const decided = [...Object.keys(DIALOGS), ...Object.keys(CHROME), ...SCREEN_READS, ...SHARED].sort();
		expect(membersOf(h.bUi)).toEqual(decided);
		expect(membersOf(h.aUi)).toEqual(decided);
	});
});

describe("a dialog from a conversation off screen", () => {
	for (const [member, decision] of Object.entries(DIALOGS)) {
		it(`${member}: waits unshown and counted, fires the waiting listener, and presents once its conversation is attached`, async () => {
			const h = await harness();
			const shown = decision.present(h.controller);
			let fired = 0;
			h.controller.onWaitingDialogsChange(() => fired++);

			const pending = decision.call(h.bUi);
			let settled = false;
			void pending.then(() => {
				settled = true;
			});
			await Promise.resolve();
			await Promise.resolve();

			expect({ settled, shown: shown(), waitingB: h.controller.waitingDialogs(h.b), fired }).toEqual({
				settled: false,
				shown: 0,
				waitingB: 1,
				fired: 1,
			});
			expect(h.controller.waitingDialogs(h.a)).toBe(0);

			h.bring(h.b);
			expect(await pending).toEqual(decision.answer);
			expect({ shown: shown(), waitingB: h.controller.waitingDialogs(h.b), fired }).toEqual({
				shown: 1,
				waitingB: 0,
				fired: 2,
			});
		});

		it(`${member}: from the conversation on screen presents at once and is never counted`, async () => {
			const h = await harness();
			const shown = decision.present(h.controller);
			let fired = 0;
			h.controller.onWaitingDialogsChange(() => fired++);
			expect(await decision.call(h.aUi)).toEqual(decision.answer);
			expect({ shown: shown(), waitingA: h.controller.waitingDialogs(h.a), fired }).toEqual({
				shown: 1,
				waitingA: 0,
				fired: 0,
			});
		});

		const fallback = decision.fallback;
		if (!fallback) continue;

		it(`${member}: an abort while it waits settles it to the fallback, drops the count, and it is never raised later`, async () => {
			const h = await harness();
			const shown = decision.present(h.controller);
			let fired = 0;
			h.controller.onWaitingDialogsChange(() => fired++);
			const abort = new AbortController();

			const pending = decision.call(h.bUi, abort.signal);
			expect(h.controller.waitingDialogs(h.b)).toBe(1);
			abort.abort();
			expect(await pending).toEqual(fallback.value);
			expect({ waitingB: h.controller.waitingDialogs(h.b), fired }).toEqual({ waitingB: 0, fired: 2 });

			// Coming back to the conversation does not raise a question it abandoned.
			h.bring(h.b);
			await Promise.resolve();
			await Promise.resolve();
			expect(shown()).toBe(0);
		});

		it(`${member}: an already-aborted signal settles to the fallback without ever counting`, async () => {
			const h = await harness();
			const shown = decision.present(h.controller);
			let fired = 0;
			h.controller.onWaitingDialogsChange(() => fired++);
			const abort = new AbortController();
			abort.abort();
			expect(await decision.call(h.bUi, abort.signal)).toEqual(fallback.value);
			expect({ shown: shown(), waitingB: h.controller.waitingDialogs(h.b), fired }).toEqual({
				shown: 0,
				waitingB: 0,
				fired: 0,
			});
		});
	}

	it("dialogs held by one conversation are counted together and presented oldest first", async () => {
		const h = await harness();
		const order: string[] = [];
		vi.spyOn(h.controller, "showHookConfirm").mockImplementation(async title => {
			order.push(title);
			return true;
		});
		vi.spyOn(h.controller, "showHookInput").mockImplementation(async title => {
			order.push(title);
			return "typed";
		});
		const first = h.bUi.confirm("first", "asked first");
		const second = h.bUi.input("second");
		expect(h.controller.waitingDialogs(h.b)).toBe(2);
		h.bring(h.b);
		await Promise.all([first, second]);
		expect(order).toEqual(["first", "second"]);
		expect(h.controller.waitingDialogs(h.b)).toBe(0);
	});

	it("a conversation that leaves the screen again holds its next dialog again", async () => {
		const h = await harness();
		const shown = DIALOGS.confirm!.present(h.controller);
		h.bring(h.b);
		expect(await h.bUi.confirm("on screen", "now")).toBe(true);
		h.bring(h.a);
		const held = h.bUi.confirm("off screen again", "later");
		expect(h.controller.waitingDialogs(h.b)).toBe(1);
		expect(await h.aUi.confirm("the one on screen", "now")).toBe(true);
		expect(shown()).toBe(2);
		h.bring(h.b);
		expect(await held).toBe(true);
		expect(shown()).toBe(3);
	});
});

describe("chrome from a conversation off screen", () => {
	for (const [member, decision] of Object.entries(CHROME)) {
		it(`${member}: is dropped while its conversation is off screen and reaches the terminal once it is on`, async () => {
			const h = await harness();
			h.editor.setText("unchanged");

			decision.invoke(h, h.bUi, "from-b-off-screen");
			expect(decision.reached(h, "from-b-off-screen")).toBe(false);

			decision.invoke(h, h.aUi, "from-a-on-screen");
			expect(decision.reached(h, "from-a-on-screen")).toBe(true);

			// Decided at call time, not bind time: the same context reaches once on
			// screen, and the one that left stops reaching.
			h.bring(h.b);
			decision.invoke(h, h.bUi, "from-b-on-screen");
			expect(decision.reached(h, "from-b-on-screen")).toBe(true);
			decision.invoke(h, h.aUi, "from-a-off-screen");
			expect(decision.reached(h, "from-a-off-screen")).toBe(false);
		});
	}
});

describe("reads from a conversation off screen", () => {
	it("getEditorText is empty off screen and the composer's text on screen", async () => {
		const h = await harness();
		h.editor.setText("draft of the conversation on screen");
		expect(h.bUi.getEditorText()).toBe("");
		expect(h.aUi.getEditorText()).toBe("draft of the conversation on screen");
	});
});

describe("members shared by every conversation", () => {
	it("pass through from off screen", async () => {
		const h = await harness();
		h.bUi.setToolsExpanded(true);
		h.bUi.addAutocompleteProvider(current => current);
		expect(h.log).toEqual(["setToolsExpanded:true", "addAutocompleteProvider:"]);
		expect(h.bUi.getToolsExpanded()).toBe(false);
		expect(h.bUi.theme).toBe(h.aUi.theme);
	});
});
