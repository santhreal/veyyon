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
 * count, and the abandoned question is never raised later. A conversation the
 * terminal releases (closed from the room, or at exit) settles every dialog it
 * holds, `terminal.custom` included, and a dialog it asks afterwards settles at
 * once. Status text and widgets are kept per conversation: set from off screen
 * they wait, and each switch takes the leaving conversation's off the terminal
 * and puts the arriving one's on; a released conversation's are forgotten.
 * Every other chrome member is dropped from off screen and reaches the
 * terminal from on screen, decided at call time rather than at bind time. An
 * autocomplete provider applies only while its conversation is on screen and
 * leaves the editor when the conversation is released. Binding a conversation
 * off screen does not wait on its `session_start`, whose handler may ask a
 * question that cannot be shown until the conversation exists and is entered.
 *
 * The controller is real. What stands in for the terminal is the controller's
 * own presentation methods, spied so a presented dialog resolves at once, and
 * the context fields those methods write through; the autocomplete stack is
 * composed the way the interactive mode composes it. The two conversations are
 * identities only: the gate compares `ctx.session` against the bound session
 * and reads nothing else of it, and an absent extension runner is the case
 * `bindSession` takes when no extension is loaded.
 *
 * NOT CAUGHT. That a presented dialog draws correctly (the dialog suites own
 * that). That the host calls `sessionAttached` on every switch and
 * `sessionReleased` on every close: the room controller suite drives
 * `attachMainSession` and `releaseHostedSession`, which the interactive mode
 * wires to them. That the interactive mode recomposes the editor's provider
 * on every attach. That a conversation starting or switching sessions drops
 * its widgets: that runs through its extension runner's actions.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import type {
	AutocompleteProviderFactory,
	ExtensionUIContext,
	TerminalInputHandler,
} from "@veyyon/coding-agent/extensibility/extensions";
import type { TerminalWidgetContent } from "@veyyon/coding-agent/extensibility/terminal-capability";
import { CustomEditor } from "@veyyon/coding-agent/modes/terminal/components/composer/custom-editor";
import {
	ExtensionUiController,
	type ExtensionUiControllerContext,
} from "@veyyon/coding-agent/modes/terminal/controllers/extension-ui-controller";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { SessionHostBindings } from "@veyyon/coding-agent/session/background-sessions";
import { getEditorTheme, initTheme } from "@veyyon/coding-agent/theme/theme";
import * as titleGenerator from "@veyyon/coding-agent/utils/title-generator";
import { Container } from "@veyyon/tui";
import type { AutocompleteProvider } from "@veyyon/utils/autocomplete";

type Outcome = { value: unknown } | { rejects: string } | { stillWaitingAfterMs: number };

/**
 * How `pending` settled: its value, or the message it rejected with. A wait
 * that has not settled within `ms` is reported as such rather than hanging the
 * suite until its timeout.
 */
function outcome(pending: Promise<unknown>, ms = 1_000): Promise<Outcome> {
	const settled = pending.then(
		(value): Outcome => ({ value }),
		(error: unknown): Outcome => ({ rejects: error instanceof Error ? error.message : String(error) }),
	);
	return Promise.race([settled, sleep(ms).then((): Outcome => ({ stillWaitingAfterMs: ms }))]);
}

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
	/** The terminal's footer status slots, by key, as the status line holds them. */
	statuses: Map<string, string>;
	/** The terminal's widget slots, by key: text rows or a component factory. */
	widgets: Map<string, TerminalWidgetContent>;
	/** Deliver raw terminal input to every listener registered with the terminal. */
	type(data: string): void;
	/** Put `session` on screen the way the host does: re-point `ctx.session`, then attach. */
	bring(session: AgentSession): void;
	/** An editor factory tagged so the call that sent it is named when it reaches the terminal. */
	editorFactory(tag: string): () => CustomEditor;
	/** The terminal's autocomplete stack, in registration order. */
	factories: AutocompleteProviderFactory[];
	/** The item values the editor's provider suggests, composed from the stack now. */
	suggestions(): Promise<string[]>;
}

async function harness(): Promise<Harness> {
	const a = { extensionRunner: undefined } as unknown as AgentSession;
	const b = { extensionRunner: undefined } as unknown as AgentSession;
	const editor = new CustomEditor(getEditorTheme());
	const log: string[] = [];
	const statuses = new Map<string, string>();
	const widgets = new Map<string, TerminalWidgetContent>();
	const inputListeners: TerminalInputHandler[] = [];
	const factoryTags = new Map<unknown, string>();
	let aUi: ExtensionUIContext | undefined;
	let bUi: ExtensionUIContext | undefined;
	const factories: AutocompleteProviderFactory[] = [];
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
		addAutocompleteProvider: (factory: AutocompleteProviderFactory) => {
			factories.push(factory);
		},
		removeAutocompleteProvider: (factory: AutocompleteProviderFactory) => {
			const index = factories.indexOf(factory);
			if (index !== -1) factories.splice(index, 1);
		},
	};
	const controller = new ExtensionUiController(ctx as unknown as ExtensionUiControllerContext);
	// The terminal's presentation, in place of drawing: each records what reached it.
	vi.spyOn(controller, "showHookNotify").mockImplementation(message => {
		log.push(`notify:${message}`);
	});
	vi.spyOn(controller, "setHookStatus").mockImplementation((key, text) => {
		log.push(`setStatus:${text}`);
		if (text === undefined) statuses.delete(key);
		else statuses.set(key, text);
	});
	vi.spyOn(controller, "setHookWidget").mockImplementation((key, content) => {
		log.push(`widget:${key}`);
		if (content === undefined) widgets.delete(key);
		else widgets.set(key, content);
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
		statuses,
		widgets,
		type: data => {
			for (const listener of inputListeners) listener(data);
		},
		bring: session => {
			const previous = ctx.session;
			ctx.session = session;
			controller.sessionAttached(session, previous);
		},
		editorFactory: tag => {
			const factory = () => new CustomEditor(getEditorTheme());
			factoryTags.set(factory, tag);
			return factory;
		},
		factories,
		suggestions: async () => {
			let provider = BASE_PROVIDER;
			for (const factory of factories) provider = factory(provider);
			return (await provider.getSuggestions([""], 0, 0))?.items.map(item => item.value) ?? [];
		},
	};
}

const BASE_PROVIDER: AutocompleteProvider = {
	getSuggestions: async () => ({ items: [], prefix: "" }),
	applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
};

/** A provider factory that adds `tag` to whatever the provider it wraps suggests. */
function suggesting(tag: string): AutocompleteProviderFactory {
	return current => ({
		getSuggestions: async (lines, cursorLine, cursorCol) => {
			const base = await current.getSuggestions(lines, cursorLine, cursorCol);
			return { items: [...(base?.items ?? []), { value: tag, label: tag }], prefix: base?.prefix ?? "" };
		},
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
			current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
	});
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
	/** How the wait settles when the terminal releases the conversation: a value, or a rejection message. */
	released: { value: unknown } | { rejects: string };
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
		released: { value: undefined },
	},
	confirm: {
		present: c => {
			const spy = vi.spyOn(c, "showHookConfirm").mockResolvedValue(true);
			return () => spy.mock.calls.length;
		},
		call: (ui, signal) => ui.confirm("Proceed?", "It writes a file", { signal }),
		answer: true,
		fallback: { value: false },
		released: { value: false },
	},
	input: {
		present: c => {
			const spy = vi.spyOn(c, "showHookInput").mockResolvedValue("typed");
			return () => spy.mock.calls.length;
		},
		call: (ui, signal) => ui.input("Name", "placeholder", { signal }),
		answer: "typed",
		fallback: { value: undefined },
		released: { value: undefined },
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
		released: { value: undefined },
	},
	editor: {
		present: c => {
			const spy = vi.spyOn(c, "showCollabAwareEditor").mockResolvedValue("edited");
			return () => spy.mock.calls.length;
		},
		call: (ui, signal) => ui.editor("Edit", "prefill", { signal }),
		answer: "edited",
		fallback: { value: undefined },
		released: { value: undefined },
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
		released: { rejects: "The conversation closed before it came on screen." },
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
	setWorkingMessage: { invoke: (_h, ui, tag) => ui.setWorkingMessage(tag), reached: logged("setWorkingMessage") },
	setTitle: { invoke: (_h, ui, tag) => ui.setTitle(tag), reached: logged("setTitle") },
	setEditorText: { invoke: (_h, ui, tag) => ui.setEditorText(tag), reached: (h, tag) => h.editor.getText() === tag },
	pasteToEditor: {
		invoke: (h, ui, tag) => {
			h.editor.setText("");
			ui.pasteToEditor(tag);
		},
		reached: (h, tag) => h.editor.getText().includes(tag),
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

/**
 * A kept chrome member: a slot on the terminal, by key, that each conversation
 * fills for itself. The terminal shows the on-screen conversation's value.
 */
interface KeptDecision {
	/** Set `key` to `value` through `ui`; undefined clears it. */
	put(ui: ExtensionUIContext, key: string, value: string | undefined): void;
	/** The value the terminal shows under `key`, or undefined when the slot is empty. */
	shown(h: Harness, key: string): string | undefined;
}

const componentTags = new WeakMap<object, string>();

function taggedComponent(tag: string): () => Container {
	const factory = () => new Container();
	componentTags.set(factory, tag);
	return factory;
}

function shownWidget(h: Harness, key: string): string | undefined {
	const content = h.widgets.get(key);
	return typeof content === "function" ? componentTags.get(content) : content?.[0];
}

const KEPT: Record<string, KeptDecision> = {
	setStatus: { put: (ui, key, value) => ui.setStatus(key, value), shown: (h, key) => h.statuses.get(key) },
	setWidget: {
		put: (ui, key, value) => ui.setWidget(key, value === undefined ? undefined : [value]),
		shown: shownWidget,
	},
	"terminal.setWidgetComponent": {
		put: (ui, key, value) =>
			ui.terminal?.setWidgetComponent(key, value === undefined ? undefined : taggedComponent(value)),
		shown: shownWidget,
	},
};

/** Reads the conversation off screen gets an empty answer to, rather than another conversation's state. */
const SCREEN_READS = ["getEditorText"];

/**
 * Members that add to the editor, which belongs to the conversation on screen:
 * each takes effect only while its conversation is on it.
 */
const SCOPED_TO_SCREEN = ["addAutocompleteProvider"];

/**
 * Members that are not screen state of one conversation and pass through from
 * any conversation: the theme, the tool expansion toggle, and the static
 * presentation flag.
 */
const SHARED = [
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
		const decided = [
			...Object.keys(DIALOGS),
			...Object.keys(CHROME),
			...Object.keys(KEPT),
			...SCREEN_READS,
			...SCOPED_TO_SCREEN,
			...SHARED,
		].sort();
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

		it(`${member}: settles when the terminal releases its conversation while it waits, drops the count, and is never raised`, async () => {
			const h = await harness();
			const shown = decision.present(h.controller);
			let fired = 0;
			h.controller.onWaitingDialogsChange(() => fired++);

			const pending = outcome(decision.call(h.bUi));
			expect(h.controller.waitingDialogs(h.b)).toBe(1);
			h.controller.sessionReleased(h.b);
			expect(await pending).toEqual(decision.released);
			expect({ waitingB: h.controller.waitingDialogs(h.b), fired }).toEqual({ waitingB: 0, fired: 2 });

			h.bring(h.b);
			await Promise.resolve();
			await Promise.resolve();
			expect(shown()).toBe(0);
		});

		it(`${member}: from a conversation already released settles at once without counting`, async () => {
			const h = await harness();
			const shown = decision.present(h.controller);
			let fired = 0;
			h.controller.onWaitingDialogsChange(() => fired++);
			h.controller.sessionReleased(h.b);
			expect(await outcome(decision.call(h.bUi))).toEqual(decision.released);
			expect({ shown: shown(), waitingB: h.controller.waitingDialogs(h.b), fired }).toEqual({
				shown: 0,
				waitingB: 0,
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

describe("status text and widgets are each conversation's own", () => {
	for (const [member, decision] of Object.entries(KEPT)) {
		it(`${member}: set off screen waits, and each switch shows the arriving conversation's and takes the leaving one's off`, async () => {
			const h = await harness();
			const on = (...keys: string[]) => Object.fromEntries(keys.map(key => [key, decision.shown(h, key)]));
			decision.put(h.aUi, "shared", "a-shared");
			decision.put(h.aUi, "only-a", "a-only");
			decision.put(h.bUi, "shared", "b-shared");
			decision.put(h.bUi, "only-b", "b-only");
			expect(on("shared", "only-a", "only-b")).toEqual({
				shared: "a-shared",
				"only-a": "a-only",
				"only-b": undefined,
			});

			h.bring(h.b);
			expect(on("shared", "only-a", "only-b")).toEqual({
				shared: "b-shared",
				"only-a": undefined,
				"only-b": "b-only",
			});

			// Changed and cleared while off screen: the terminal shows the latest.
			decision.put(h.aUi, "shared", "a-shared-later");
			decision.put(h.aUi, "only-a", undefined);
			expect(on("shared", "only-a")).toEqual({ shared: "b-shared", "only-a": undefined });
			h.bring(h.a);
			expect(on("shared", "only-a", "only-b")).toEqual({
				shared: "a-shared-later",
				"only-a": undefined,
				"only-b": undefined,
			});
		});

		it(`${member}: a released conversation's are forgotten, and one it sets afterwards is never shown`, async () => {
			const h = await harness();
			decision.put(h.bUi, "held", "b-held");
			h.controller.sessionReleased(h.b);
			decision.put(h.bUi, "late", "b-late");
			h.bring(h.b);
			expect([decision.shown(h, "held"), decision.shown(h, "late")]).toEqual([undefined, undefined]);
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
		expect(h.log).toEqual(["setToolsExpanded:true"]);
		expect(h.bUi.getToolsExpanded()).toBe(false);
		expect(h.bUi.theme).toBe(h.aUi.theme);
	});
});

describe("autocomplete from a conversation", () => {
	it("applies only while its conversation is on screen, decided when the editor's provider is composed", async () => {
		const h = await harness();
		h.aUi.addAutocompleteProvider(suggesting("from-a"));
		h.bUi.addAutocompleteProvider(suggesting("from-b"));
		expect(await h.suggestions()).toEqual(["from-a"]);
		h.bring(h.b);
		expect(await h.suggestions()).toEqual(["from-b"]);
	});

	it("leaves the editor when its conversation is released, and one added afterwards never joins", async () => {
		const h = await harness();
		h.aUi.addAutocompleteProvider(suggesting("from-a"));
		h.bUi.addAutocompleteProvider(suggesting("from-b"));
		h.bUi.addAutocompleteProvider(suggesting("from-b-again"));
		h.controller.sessionReleased(h.b);
		h.bUi.addAutocompleteProvider(suggesting("from-b-after-release"));
		// On screen, a released conversation would show every provider still stacked.
		h.bring(h.b);
		expect(await h.suggestions()).toEqual([]);
		h.bring(h.a);
		expect(await h.suggestions()).toEqual(["from-a"]);
	});
});

const BINDINGS: SessionHostBindings = { setToolUIContext: () => {}, setToolNotifier: () => {} };

describe("binding a conversation", () => {
	it("off screen, a session_start that asks a question does not hold the binding; the question waits for the conversation", async () => {
		const h = await harness();
		const shown = DIALOGS.confirm!.present(h.controller);
		let context: ExtensionUIContext | undefined;
		let handler: Promise<boolean> | undefined;
		const c = {
			extensionRunner: {
				initialize: (_actions: unknown, _context: unknown, _commands: unknown, ui: ExtensionUIContext) => {
					context = ui;
				},
				onError: () => {},
				emit: async () => {
					if (!context) throw new Error("Expected the runner to be initialized before session_start");
					handler = context.confirm("Trust this project?", "asked from session_start");
					await handler;
				},
			},
		} as unknown as AgentSession;

		const bound = await Promise.race([
			h.controller.bindSession(c, BINDINGS).then(() => "bound"),
			sleep(1_000).then(() => "still waiting after 1s"),
		]);
		expect(bound).toBe("bound");
		expect({ shown: shown(), waiting: h.controller.waitingDialogs(c) }).toEqual({ shown: 0, waiting: 1 });

		h.bring(c);
		expect(await handler).toBe(true);
		expect(shown()).toBe(1);
	});

	it("on screen, the binding resolves only once session_start has finished", async () => {
		const h = await harness();
		const started = Promise.withResolvers<void>();
		const d = {
			extensionRunner: { initialize: () => {}, onError: () => {}, emit: () => started.promise },
		} as unknown as AgentSession;
		h.bring(d);
		let bound = false;
		const binding = h.controller.bindSession(d, BINDINGS).then(() => {
			bound = true;
		});
		await sleep(20);
		expect(bound).toBe(false);
		started.resolve();
		await binding;
		expect(bound).toBe(true);
	});
});
