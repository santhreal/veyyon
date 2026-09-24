/**
 * A room member comes on screen only through the claim.
 *
 * WHY THIS SUITE EXISTS. A room is several driving conversations in one
 * terminal, one on screen. `RoomController` owns the one transaction that puts
 * a member on screen, and the verbs around it: open a peer, cycle, close, keep
 * drafts, count who is working and who is waiting. The defect class is that
 * transaction or a verb getting a step out of order or skipping one:
 *
 * - attaching a conversation before its process scope is claimed, so a claim
 *   that fails leaves the screen on a conversation whose project the process
 *   is not in, or leaves the one on screen half-detached (its draft cleared,
 *   its background accounting moved) with nothing said;
 * - a draft typed for one conversation shown in another, or lost on the way,
 *   its attached images included;
 * - terminal chrome re-rooted for nothing, or a chrome failure undoing a
 *   switch the operator already sees; any step after the attach that fails
 *   reported as a refused switch, motion on or off;
 * - a new peer built on screen (holding the process scope) or never hosted, so
 *   its dialogs have nowhere to wait; a second peer built while one opens; a
 *   peer that failed to join left running where nothing lists it;
 * - closing the launch conversation or the one on screen, or closing a peer
 *   without stopping its turn, keeping its draft, disposing it and dropping it
 *   from the room; a close that fails forgetting the conversation, so exit
 *   never disposes it;
 * - a question asked off screen that nobody is told about, or told twice;
 * - a cycle that does not wrap, or a row the registry lists before its session
 *   attaches taken for a member and dereferenced.
 *
 * Driven through the controller's public API over real `AgentSession`s in a
 * real `AgentRegistry`, a real TUI over a virtual terminal, a real composer and
 * a real status line. A switch with motion off is the attach and one repaint;
 * with motion on it is the stage's travel, driven by the real clock. The
 * context members the interactive mode implements (`attachMainSession`,
 * `hostSession`, `applyCwdChange`, the waiting-dialog counts) are stand-ins
 * that do what that implementation does for the fields the controller reads,
 * and record the order they ran in. A claim that fails is the session's real
 * failure path: its prompt rebuild throws while it re-scopes.
 *
 * NOT CAUGHT. The interactive mode's own `attachMainSession`, and the dialog
 * gate behind `waitingDialogs` (its own suite covers that). The stage's
 * painting and its keys are the stage suites'. The sdk's dispose wrapper,
 * which is what removes a closed peer from the registry in production, is
 * reproduced here rather than run.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { CustomEditor } from "@veyyon/coding-agent/modes/terminal/components/composer/custom-editor";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/terminal/components/status-line/component";
import type { EventController } from "@veyyon/coding-agent/modes/terminal/controllers/event-controller";
import {
	RoomController,
	type RoomControllerContext,
} from "@veyyon/coding-agent/modes/terminal/controllers/room-controller";
import { StatusPresentationProducer } from "@veyyon/coding-agent/presentation/status-producer";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionDisposeOptions } from "@veyyon/coding-agent/session/agent-session-types";
import { BackgroundSessions } from "@veyyon/coding-agent/session/background-sessions";
import { getEditorTheme, initTheme } from "@veyyon/coding-agent/theme/theme";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TERMINAL, TUI } from "@veyyon/tui";
import { getProjectDir, setProjectDir, TempDir } from "@veyyon/utils";
import { VirtualTerminal } from "../../../../../../hosts/terminal/engine/test/virtual-terminal";
import {
	beginSettingsTest,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../../../helpers/settings-test-state";

// `TERMINAL` declares the capability readonly; the switch reads it for motion.
const terminalCaps: { trueColor: boolean } = TERMINAL;
const NO_PEER = "No other conversation in this terminal — /room new opens one beside this";
/** What the first arrival in another conversation adds: the room view's key, with the default bindings. */
const TEACH = " · alt+w shows every conversation";

interface Conversation {
	id: string;
	session: AgentSession;
	/** Make the next prompt build throw, as a broken project configuration would; the next claim fails. */
	failNextPromptBuild(): void;
	/** Hold this conversation's next claim until the returned release is called. */
	holdNextClaim(): () => void;
	/** Start a turn that runs until it is aborted; resolves once the provider is asked. */
	startTurn(): Promise<void>;
	/** Whether the last turn started has settled. */
	turnSettled(): boolean;
}

interface Harness {
	ctx: RoomControllerContext;
	room: RoomController;
	ui: TUI;
	statusLine: StatusLineComponent;
	statuses: string[];
	errors: string[];
	warnings: string[];
	/** Make the next `applyCwdChange` throw with `message`. */
	failNextCwdChange(message: string): void;
	/** Make the next `reloadTodos` reject with `message`, as a step after the attach failing. */
	failNextTodosReload(message: string): void;
	/** Make the next `hostSession` reject with `message`, as a new conversation failing to join. */
	failNextHost(message: string): void;
	/** Set how many dialogs `session` is holding, and tell the listeners, as the dialog gate does. */
	hold(session: AgentSession, count: number): void;
}

let settingsState: SettingsTestState | undefined;
let previousTrueColor: boolean;
let tempDir: TempDir;
let dirA: string;
let dirB: string;
let shared: Settings;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let registry: AgentRegistry;
/** The transaction steps every stand-in and traced claim records, in the order they ran. */
let steps: string[];
let conversations: Conversation[];
let turns: Promise<unknown>[];
let harnesses: Harness[];

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	previousTrueColor = terminalCaps.trueColor;
	terminalCaps.trueColor = false;
	tempDir = TempDir.createSync("@pi-room-controller-");
	dirA = makeDir("project-a");
	dirB = makeDir("project-b");
	setProjectDir(dirA);
	shared = Settings.isolated();
	await shared.reloadForCwd(dirA);
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	registry = new AgentRegistry();
	steps = [];
	conversations = [];
	turns = [];
	harnesses = [];
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const h of harnesses) {
		h.room.dispose();
		h.ui.stop();
	}
	for (const { session } of conversations) {
		if (session.isStreaming) await session.abort();
	}
	await Promise.allSettled(turns);
	for (const { session } of conversations) {
		BackgroundSessions.global().release(session);
		await session.dispose();
	}
	authStorage.close();
	terminalCaps.trueColor = previousTrueColor;
	// Puts the project dir and cwd back before the directories they point into go.
	restoreSettingsTestState(settingsState);
	tempDir.removeSync();
});

function makeDir(name: string): string {
	const dir = path.join(tempDir.path(), name);
	fs.mkdirSync(dir, { recursive: true });
	return fs.realpathSync(dir);
}

function finishedTurn(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

/**
 * A driving conversation at `dir`, registered the way the sdk registers one:
 * the row first with no session, the session attached after, and a dispose
 * that forgets the row. File-backed, so a draft can be kept beside it.
 */
function openConversation(name: string, dir: string, room?: string): Conversation {
	const id = `main:${name}`;
	const sessionManager = SessionManager.create(dir, path.join(tempDir.path(), "sessions", name));
	const sessionFile = sessionManager.getSessionFile() ?? null;
	registry.register({
		id,
		displayName: "main",
		kind: "main",
		session: null,
		sessionFile,
		scope: sessionManager.getSessionId(),
		room,
		status: "running",
	});
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected the bundled anthropic model to exist");
	let failNext = false;
	let claimGate: Promise<void> | undefined;
	let called = Promise.withResolvers<void>();
	let settled = true;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (_model, _context, options) => {
			const stream = new AssistantMessageEventStream();
			options?.signal?.addEventListener(
				"abort",
				() => stream.push({ type: "error", reason: "aborted", error: finishedTurn("aborted") }),
				{ once: true },
			);
			called.resolve();
			return stream;
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: shared,
		modelRegistry,
		agentId: id,
		agentRegistry: registry,
		rebuildSystemPrompt: async () => {
			if (failNext) {
				failNext = false;
				throw new Error(`prompt build failed for ${sessionManager.getCwd()}`);
			}
			return { systemPrompt: [`cwd=${sessionManager.getCwd()}`] };
		},
		refreshSecretRuntime: async () => undefined,
	});
	registry.attachSession(id, session, sessionFile);
	// The host's dispose forgets the row (sdk.ts wraps every session this way).
	const dispose = session.dispose.bind(session);
	session.dispose = async (options?: AgentSessionDisposeOptions) => {
		try {
			await dispose(options);
		} finally {
			registry.unregister(id);
		}
	};
	// Every claim is traced, so the order of claim and attach is observable.
	const claim = session.claimForeground.bind(session);
	vi.spyOn(session, "claimForeground").mockImplementation(async () => {
		steps.push(`claim:${id}`);
		const gate = claimGate;
		claimGate = undefined;
		if (gate) await gate;
		await claim();
		steps.push(`claimed:${id}`);
	});
	const conversation: Conversation = {
		id,
		session,
		failNextPromptBuild: () => {
			failNext = true;
		},
		holdNextClaim: () => {
			const gate = Promise.withResolvers<void>();
			claimGate = gate.promise;
			return gate.resolve;
		},
		startTurn: async () => {
			called = Promise.withResolvers<void>();
			settled = false;
			const turn = session.prompt("keep working").finally(() => {
				settled = true;
			});
			turns.push(turn);
			await Promise.race([called.promise, turn]);
		},
		turnSettled: () => settled,
	};
	conversations.push(conversation);
	return conversation;
}

/**
 * The launch conversation `a` on screen at dirA, and one peer per entry of
 * `peers`, each at its directory, in a room `a` opened. With no peers, `a` is
 * in no room.
 */
function openRoom(...peers: Array<{ name: string; dir: string }>): {
	h: Harness;
	a: Conversation;
	peers: Conversation[];
} {
	const a = openConversation("a", dirA);
	const room = peers.length > 0 ? registry.ensureRoom(a.id) : undefined;
	const others = peers.map(peer => {
		const conversation = openConversation(peer.name, peer.dir, room);
		conversation.session.releaseForeground();
		return conversation;
	});
	return { h: harness(a), a, peers: others };
}

function harness(launch: Conversation): Harness {
	const ui = new TUI(new VirtualTerminal(100, 30));
	const statusLine = new StatusLineComponent(new StatusPresentationProducer(launch.session));
	const statuses: string[] = [];
	const errors: string[] = [];
	const warnings: string[] = [];
	const waiting = new Map<AgentSession, number>();
	const waitingListeners = new Set<() => void>();
	let cwdFailure: string | undefined;
	let todosFailure: string | undefined;
	let hostFailure: string | undefined;
	const ctx: RoomControllerContext = {
		ui,
		editor: new CustomEditor(getEditorTheme()),
		statusLine,
		session: launch.session,
		sessionManager: launch.session.sessionManager,
		settings: shared,
		keybindings: KeybindingsManager.inMemory(),
		launchSession: launch.session,
		focusedAgentId: undefined,
		unfocusSession: async () => {},
		// The transcript's event controller: its catch-up of a turn in flight has its own suite; here it
		// only records that the switch asked for it, after the transcript was rendered.
		eventController: {
			resumeTurn: async () => {
				steps.push("resume");
			},
		} as unknown as EventController,
		// What the interactive mode's attach does to the fields the controller reads.
		attachMainSession: next => {
			const previous = ctx.session;
			if (next === previous) return BackgroundSessions.global().describeAttached(previous);
			steps.push(`attach:${next.getAgentId()}`);
			previous.releaseForeground();
			ctx.session = next;
			ctx.sessionManager = next.sessionManager;
			ctx.settings = next.settings;
			return BackgroundSessions.global().keep(previous);
		},
		createNextSession: async options => {
			steps.push("create");
			const created = openConversation(`peer${conversations.length}`, dirA, options?.room);
			return { session: created.session, bindings: { setToolUIContext: () => {}, setToolNotifier: () => {} } };
		},
		hostSession: async hosted => {
			steps.push(`host:${hosted.session.getAgentId()}:${hosted.session.isForeground ? "foreground" : "background"}`);
			const failure = hostFailure;
			hostFailure = undefined;
			if (failure) throw new Error(failure);
		},
		dismissHeldUi: session => {
			steps.push(`dismiss:${session.getAgentId()}`);
		},
		releaseHostedSession: session => {
			steps.push(`release:${session.getAgentId()}`);
		},
		applyCwdChange: async cwd => {
			steps.push(`chrome:${cwd}`);
			const failure = cwdFailure;
			cwdFailure = undefined;
			if (failure) throw new Error(failure);
		},
		reloadTodos: async () => {
			steps.push("todos");
			const failure = todosFailure;
			todosFailure = undefined;
			if (failure) throw new Error(failure);
		},
		clearTransientSessionUi: () => {},
		renderInitialMessages: () => {
			steps.push("render");
		},
		resetObserverRegistry: () => {},
		updateEditorBorderColor: () => {},
		waitingDialogs: session => waiting.get(session) ?? 0,
		onWaitingDialogsChange: listener => {
			waitingListeners.add(listener);
			return () => waitingListeners.delete(listener);
		},
		showStatus: message => {
			statuses.push(message);
		},
		showError: message => {
			errors.push(message);
		},
		showWarning: message => {
			warnings.push(message);
		},
	};
	const room = new RoomController(ctx, registry);
	room.install();
	const h: Harness = {
		ctx,
		room,
		ui,
		statusLine,
		statuses,
		errors,
		warnings,
		failNextCwdChange: message => {
			cwdFailure = message;
		},
		failNextTodosReload: message => {
			todosFailure = message;
		},
		failNextHost: message => {
			hostFailure = message;
		},
		hold: (session, count) => {
			waiting.set(session, count);
			for (const listener of waitingListeners) listener();
		},
	};
	harnesses.push(h);
	return h;
}

function kept(): AgentSession[] {
	return BackgroundSessions.global().kept.map(entry => entry.session);
}

/** The claim and attach steps, in order. */
function screenSteps(): string[] {
	return steps.filter(step => /^(claim|claimed|attach|create|host):/.test(step) || step === "create");
}

/** Wait, bounded, for `read` to hold. A hang is a failure, not a stall. */
async function until(read: () => boolean, what: string, ms = 4_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!read()) {
		if (Date.now() > deadline) throw new Error(`Timed out after ${ms}ms waiting for ${what}`);
		await sleep(5);
	}
}

// ---------------------------------------------------------------- the claim

describe("the switch claims the process scope before it attaches", () => {
	it("attaches the target only once its claim has finished, then the process is in its project", async () => {
		const {
			h,
			a,
			peers: [b],
		} = openRoom({ name: "b", dir: dirB });
		const release = b!.holdNextClaim();
		const switching = h.room.switchTo(b!.id);
		await sleep(20);
		expect(screenSteps()).toEqual([`claim:${b!.id}`]);
		expect(h.ctx.session).toBe(a.session);

		release();
		await switching;
		expect(screenSteps()).toEqual([`claim:${b!.id}`, `claimed:${b!.id}`, `attach:${b!.id}`]);
		// The transcript is drawn for the conversation now on screen, then its turn in flight is resumed.
		expect(steps.filter(step => ["render", "resume"].includes(step) || step.startsWith("attach:"))).toEqual([
			`attach:${b!.id}`,
			"render",
			"resume",
		]);
		expect(h.ctx.session).toBe(b!.session);
		expect({ b: b!.session.isForeground, a: a.session.isForeground }).toEqual({ b: true, a: false });
		expect(getProjectDir()).toBe(dirB);
		expect(h.statuses.at(-1)).toBe(`Switched to conversation 2${TEACH}`);
		expect(h.errors).toEqual([]);
	});

	/**
	 * B is finishing a turn off screen, so it is in the background set. Its
	 * claim fails. Nothing the operator owns moved: the conversation on
	 * screen, its draft, the background set, the process scope. The failure is
	 * said, and the next switch is not blocked behind it.
	 */
	it("a claim that throws leaves the screen, the draft and the background set untouched and says why", async () => {
		const {
			h,
			a,
			peers: [b],
		} = openRoom({ name: "b", dir: dirB });
		await b!.startTurn();
		BackgroundSessions.global().keep(b!.session);
		h.ctx.editor.setText("draft for a");
		b!.failNextPromptBuild();

		await h.room.switchTo(b!.id);

		expect(h.ctx.session).toBe(a.session);
		expect(h.ctx.sessionManager).toBe(a.session.sessionManager);
		expect(h.ctx.editor.getText()).toBe("draft for a");
		expect(kept()).toEqual([b!.session]);
		expect(steps.filter(step => step.startsWith("attach:"))).toEqual([]);
		expect(h.errors).toEqual([`Could not switch: prompt build failed for ${dirB}`]);
		expect({ a: a.session.isForeground, b: b!.session.isForeground }).toEqual({ a: true, b: false });
		// The conversation on screen is the one the process is scoped to.
		expect({ projectDir: getProjectDir(), settings: shared.getCwd() }).toEqual({ projectDir: dirA, settings: dirA });

		await h.room.switchTo(b!.id);
		expect(h.ctx.session).toBe(b!.session);
		expect(kept()).not.toContain(b!.session);
		// Named by the prompt it is on, since it has no name; the failed switch said
		// nothing, so this is the first arrival and teaches the room key.
		expect(h.statuses.at(-1)).toBe(`Switched to 2 · keep working — it is still working${TEACH}`);
	});

	it("refuses a stranger by name, and moves nothing", async () => {
		const { h, a } = openRoom({ name: "b", dir: dirB });
		openConversation("elsewhere", dirA);
		await h.room.switchTo("main:elsewhere");
		expect(h.errors).toEqual([
			'"main:elsewhere" is not a peer of this conversation. Run /room list to see the room.',
		]);
		expect(h.ctx.session).toBe(a.session);
		expect(screenSteps()).toEqual([]);
	});
});

describe("drafts", () => {
	/**
	 * The composer is one widget shared by every conversation. What was typed
	 * for one leaves with it and comes back with it; a whitespace-only draft is
	 * not a draft.
	 */
	it("each conversation's unsent draft leaves the screen with it and comes back with it", async () => {
		const {
			h,
			peers: [b, c],
		} = openRoom({ name: "b", dir: dirB }, { name: "c", dir: dirA });
		const editor = h.ctx.editor;
		editor.setText("draft for a");
		await h.room.switchTo(b!.id);
		expect(editor.getText()).toBe("");
		editor.setText("draft for b");
		await h.room.switchTo(c!.id);
		expect(editor.getText()).toBe("");
		editor.setText("   ");
		await h.room.switchTo(h.ctx.launchSession.getAgentId()!);
		expect(editor.getText()).toBe("draft for a");
		await h.room.switchTo(c!.id);
		expect(editor.getText()).toBe("");
		await h.room.switchTo(b!.id);
		expect(editor.getText()).toBe("draft for b");
	});

	it("persistDrafts writes every off-screen draft beside its transcript and not the one on screen", async () => {
		const {
			h,
			a,
			peers: [b, c],
		} = openRoom({ name: "b", dir: dirB }, { name: "c", dir: dirA });
		h.ctx.editor.setText("draft for a");
		await h.room.switchTo(b!.id);
		h.ctx.editor.setText("draft for b");
		await h.room.switchTo(c!.id);
		h.ctx.editor.setText("draft for c, on screen");

		await h.room.persistDrafts();

		expect({
			a: await a.session.sessionManager.consumeDraft(),
			b: await b!.session.sessionManager.consumeDraft(),
			c: await c!.session.sessionManager.consumeDraft(),
		}).toEqual({ a: "draft for a", b: "draft for b", c: null });
		expect(h.ctx.editor.getText()).toBe("draft for c, on screen");
	});

	/**
	 * A draft is its text and its attachments. An image left on the shared
	 * composer by a switch could be sent from the conversation that did not
	 * attach it, and the one that did would come back without it.
	 */
	it("an attached image leaves the screen with its conversation and comes back with it", async () => {
		const {
			h,
			a,
			peers: [b],
		} = openRoom({ name: "b", dir: dirB });
		const editor = h.ctx.editor;
		const image = {
			kind: "image" as const,
			name: "diagram.png",
			data: "aGVsbG8=",
			mimeType: "image/png",
			uri: "file:///repo/diagram.png",
		};
		editor.setText("explain this");
		editor.attachments = [image];
		await h.room.switchTo(b!.id);
		expect({ text: editor.getText(), attachments: editor.attachments }).toEqual({ text: "", attachments: [] });
		await h.room.switchTo(a.id);
		expect({ text: editor.getText(), attachments: editor.attachments }).toEqual({
			text: "explain this",
			attachments: [image],
		});

		// An image with no text is a draft too.
		editor.setText("");
		await h.room.switchTo(b!.id);
		expect(editor.attachments).toEqual([]);
		await h.room.switchTo(a.id);
		expect({ text: editor.getText(), attachments: editor.attachments }).toEqual({ text: "", attachments: [image] });
	});

	/**
	 * The room view shows what each conversation's composer holds: the draft
	 * kept for one off screen, and the composer's own for the one on screen. A
	 * member reporting nothing, or another conversation's draft, would hide the
	 * text the room is keeping for it.
	 */
	it("each member reports its own draft to the room view, the one on screen included", async () => {
		const {
			h,
			a,
			peers: [b, c],
		} = openRoom({ name: "b", dir: dirB }, { name: "c", dir: dirA });
		const editor = h.ctx.editor;
		editor.setText("\n  draft for a\nits second line");
		editor.attachments = [{ kind: "image", name: "diagram.png", data: "aGVsbG8=", mimeType: "image/png" }];
		await h.room.switchTo(b!.id);
		editor.setText("draft for b");
		await h.room.openView();
		expect(h.room.viewOpen).toBe(true);
		expect(Object.fromEntries(h.room.members().map(member => [member.id, member.draft]))).toEqual({
			[a.id]: { line: "draft for a", images: 1, files: 0 },
			[b!.id]: { line: "draft for b", images: 0, files: 0 },
			[c!.id]: undefined,
		});
	});
});

describe("the terminal's chrome", () => {
	it("is re-rooted only when the conversation coming on screen is in another directory", async () => {
		const {
			h,
			peers: [b, c],
		} = openRoom({ name: "b", dir: dirB }, { name: "c", dir: dirA });
		await h.room.switchTo(c!.id);
		expect(steps.filter(step => step.startsWith("chrome:"))).toEqual([]);
		await h.room.switchTo(b!.id);
		await h.room.switchTo(c!.id);
		expect(steps.filter(step => step.startsWith("chrome:"))).toEqual([`chrome:${dirB}`, `chrome:${dirA}`]);
	});

	it("a chrome refresh that fails is a warning, not a rollback", async () => {
		const {
			h,
			peers: [b],
		} = openRoom({ name: "b", dir: dirB });
		h.failNextCwdChange("no command list here");
		await h.room.switchTo(b!.id);
		expect(h.ctx.session).toBe(b!.session);
		expect(getProjectDir()).toBe(dirB);
		expect(h.warnings).toEqual([
			`Switched, but the command list for ${dirB} could not be loaded: no command list here`,
		]);
		expect(h.errors).toEqual([]);
		expect(steps.slice(steps.indexOf(`chrome:${dirB}`))).toEqual([`chrome:${dirB}`, "todos"]);
		expect(h.statuses.at(-1)).toBe(`Switched to conversation 2${TEACH}`);
	});

	/**
	 * Once the target is attached the screen has changed, whatever fails after
	 * it. A failure reported as a refused switch would leave the room believing
	 * the old conversation is on screen.
	 */
	it("a step after the attach that fails is a warning, and the switch stands", async () => {
		const {
			h,
			peers: [b],
		} = openRoom({ name: "b", dir: dirB });
		h.failNextTodosReload("todo store unreadable");
		await h.room.switchTo(b!.id);
		expect(h.ctx.session).toBe(b!.session);
		expect(h.errors).toEqual([]);
		expect(h.warnings).toEqual(["Switched, but the screen did not finish loading: todo store unreadable"]);
	});
});

describe("a new peer", () => {
	/**
	 * Built for the room, not for the screen: it is released from the process
	 * scope and hosted (its dialogs bound, gated) before the switch claims it.
	 */
	it("is built in this room, released from the foreground and hosted before it is entered", async () => {
		const { h, a } = openRoom();
		await h.room.openPeer();
		const created = conversations.at(-1)!;
		expect(created).not.toBe(a);
		expect(screenSteps()).toEqual([
			"create",
			`host:${created.id}:background`,
			`claim:${created.id}`,
			`claimed:${created.id}`,
			`attach:${created.id}`,
		]);
		const room = registry.get(a.id)?.room;
		expect(room).toBeDefined();
		expect(registry.get(created.id)?.room).toBe(room);
		expect(h.ctx.session).toBe(created.session);
		expect(h.room.members().map(member => member.id)).toEqual([a.id, created.id]);
	});

	it("is built once when asked for twice while it opens; the second request is told so", async () => {
		const { h } = openRoom();
		const first = h.room.openPeer();
		await h.room.openPeer();
		await first;
		expect(steps.filter(step => step === "create")).toEqual(["create"]);
		expect(h.statuses).toContain("A new conversation is already opening");
		expect(h.errors).toEqual([]);
	});

	/**
	 * A conversation that was built but could not join the room is one nothing
	 * lists and nothing can enter: it is closed, not left running unseen.
	 */
	it("that fails to join is closed rather than left running, and the screen stays where it was", async () => {
		const { h, a } = openRoom();
		h.failNextHost("bind failed");
		await h.room.openPeer();
		const created = conversations.at(-1)!;
		expect(created).not.toBe(a);
		expect(h.errors).toEqual(["Could not open a peer conversation: bind failed"]);
		expect(steps.filter(step => step.startsWith("dismiss:") || step.startsWith("release:"))).toEqual([
			`dismiss:${created.id}`,
			`release:${created.id}`,
		]);
		expect(registry.get(created.id)).toBeUndefined();
		expect(h.ctx.session).toBe(a.session);
	});
});

describe("closing a conversation", () => {
	it("refuses the conversation on screen and the launch conversation, with their reasons, and touches neither", async () => {
		const {
			h,
			a,
			peers: [b],
		} = openRoom({ name: "b", dir: dirB });
		const onScreen = "That is the conversation on screen. Enter another one, then close it from there.";
		expect(await h.room.close(a.id)).toBe(onScreen);
		await h.room.switchTo(b!.id);
		expect(await h.room.close(b!.id)).toBe(onScreen);
		expect(await h.room.close(a.id)).toBe(
			"The first conversation holds the MCP servers and background jobs the others share, so it stays open until you exit.",
		);
		expect(registry.get(a.id)?.session).toBe(a.session);
		expect(registry.get(b!.id)?.session).toBe(b!.session);
		expect(steps.filter(step => step.startsWith("release:"))).toEqual([]);
	});

	it("stops a working peer, keeps its draft beside its transcript, disposes it and takes it out of the room", async () => {
		const {
			h,
			a,
			peers: [b, c],
		} = openRoom({ name: "b", dir: dirB }, { name: "c", dir: dirA });
		await c!.startTurn();
		await h.room.switchTo(c!.id);
		h.ctx.editor.setText("draft for c");
		await h.room.switchTo(a.id);
		expect(kept()).toContain(c!.session);
		expect(h.statusLine.roomPeers).toEqual({ peers: 2, working: 1, waiting: 0 });

		expect(await h.room.close(c!.id)).toBeUndefined();

		expect(c!.session.isStreaming).toBe(false);
		expect(c!.turnSettled()).toBe(true);
		expect(await c!.session.sessionManager.consumeDraft()).toBe("draft for c");
		expect(registry.get(c!.id)).toBeUndefined();
		expect(steps.filter(step => step.startsWith("release:"))).toEqual([`release:${c!.id}`]);
		expect(kept()).not.toContain(c!.session);
		expect(h.room.members().map(member => member.id)).toEqual([a.id, b!.id]);
		expect(h.statusLine.roomPeers).toEqual({ peers: 1, working: 0, waiting: 0 });
	});

	/**
	 * Its held UI is dismissed before the turn is stopped, but it stays hosted
	 * until it is disposed: a close that fails leaves it for exit to dispose.
	 */
	it("that fails keeps the conversation hosted and in the room, and says why", async () => {
		const {
			h,
			a,
			peers: [b],
		} = openRoom({ name: "b", dir: dirB });
		await h.room.switchTo(b!.id);
		h.ctx.editor.setText("draft for b");
		await h.room.switchTo(a.id);
		vi.spyOn(b!.session.sessionManager, "saveDraft").mockRejectedValue(new Error("disk full"));
		expect(await h.room.close(b!.id)).toBe("Could not close that conversation: disk full");
		expect(steps.filter(step => step.startsWith("dismiss:") || step.startsWith("release:"))).toEqual([
			`dismiss:${b!.id}`,
		]);
		expect(registry.get(b!.id)?.session).toBe(b!.session);
	});
});

describe("a question asked off screen", () => {
	it("is said once on the status line, naming the conversation, and the chip counts it as waiting", async () => {
		const {
			h,
			a,
			peers: [b, c],
		} = openRoom({ name: "b", dir: dirB }, { name: "c", dir: dirA });
		await b!.session.sessionManager.setSessionName("Refactor parser", "user");
		const hint = "needs you — alt+w opens the room";

		h.hold(b!.session, 1);
		expect(h.statuses).toEqual([`2 · Refactor parser ${hint}`]);
		expect(h.statusLine.roomPeers).toEqual({ peers: 2, working: 0, waiting: 1 });

		h.hold(b!.session, 1);
		h.hold(a.session, 1);
		expect(h.statuses).toEqual([`2 · Refactor parser ${hint}`]);

		await c!.startTurn();
		await until(() => h.statusLine.roomPeers.working === 1, "the working peer to be counted");
		h.hold(c!.session, 1);
		// Named by the prompt it is on, since it has no name.
		expect(h.statuses).toEqual([`2 · Refactor parser ${hint}`, `3 · keep working ${hint}`]);
		// A peer both working and waiting counts as waiting: the question is the news.
		expect(h.statusLine.roomPeers).toEqual({ peers: 2, working: 0, waiting: 2 });

		h.hold(b!.session, 0);
		expect(h.statusLine.roomPeers).toEqual({ peers: 2, working: 0, waiting: 1 });
	});
});

describe("cycling", () => {
	it("moves to the next member in room order and wraps in both directions", async () => {
		const {
			h,
			a,
			peers: [b, c],
		} = openRoom({ name: "b", dir: dirA }, { name: "c", dir: dirA });
		const onScreen: string[] = [];
		for (const step of [1, 1, 1, -1, -1, -1] as const) {
			await h.room.cycle(step);
			onScreen.push(h.ctx.session.getAgentId()!);
		}
		expect(onScreen).toEqual([b!.id, c!.id, a.id, c!.id, b!.id, a.id]);
	});

	it("with fewer than two members only reports that there is nowhere to go", async () => {
		const { h, a } = openRoom();
		await h.room.cycle(1);
		await h.room.cycle(-1);
		expect(h.statuses).toEqual([NO_PEER, NO_PEER]);
		expect(h.ctx.session).toBe(a.session);
		expect(screenSteps()).toEqual([]);
	});
});

describe("the first arrival in another conversation", () => {
	/**
	 * A room of two is where the view is first needed, and the arrival line is
	 * what is on screen when it is. It names the key once; every later arrival
	 * only says where the screen is, so the line does not become noise.
	 */
	it("says how to see every conversation, once", async () => {
		const {
			h,
			a,
			peers: [b],
		} = openRoom({ name: "b", dir: dirA });
		await h.room.switchTo(b!.id);
		await h.room.switchTo(a.id);
		await h.room.switchTo(b!.id);
		expect(h.statuses).toEqual([
			`Switched to conversation 2${TEACH}`,
			"Switched to conversation 1",
			"Switched to conversation 2",
		]);
	});
});

describe("a row the registry lists before its session attaches", () => {
	/**
	 * The sdk registers a driver with `session: null` and attaches the session
	 * after building it. In that window the row is in the room and nothing can
	 * be drawn or counted for it.
	 */
	it("is not a member, is not counted, and nothing that reads the room throws", async () => {
		const {
			h,
			a,
			peers: [b],
		} = openRoom({ name: "b", dir: dirB });
		registry.register({
			id: "main:pending",
			displayName: "main",
			kind: "main",
			session: null,
			room: registry.get(a.id)?.room,
			status: "running",
		});
		expect(h.room.members().map(member => member.id)).toEqual([a.id, b!.id]);
		expect(h.room.describe()).not.toContain("main:pending");
		h.hold(b!.session, 1);
		expect(h.statusLine.roomPeers).toEqual({ peers: 1, working: 0, waiting: 1 });
		expect(h.room.resolveArgument("3")).toBeUndefined();
		await h.room.cycle(1);
		expect(h.ctx.session).toBe(b!.session);
	});
});

describe("with motion on, the quick switch travels through the stage", () => {
	beforeEach(() => {
		terminalCaps.trueColor = true;
	});

	it("shows the stage, puts the target on screen under it, and lands", async () => {
		const {
			h,
			peers: [b],
		} = openRoom({ name: "b", dir: dirB });
		// The landing frame the stage composes already carries the status line, so the screen
		// does not jump a row when the stage lifts: the status is shown before that frame is composed.
		const shownWhenComposed: string[][] = [];
		const compose = h.ui.composeViewport.bind(h.ui);
		vi.spyOn(h.ui, "composeViewport").mockImplementation(() => {
			shownWhenComposed.push([...h.statuses]);
			return compose();
		});
		await h.room.switchTo(b!.id);
		expect(h.room.viewOpen).toBe(true);
		await until(() => !h.room.viewOpen, "the stage to land");
		expect(screenSteps()).toEqual([`claim:${b!.id}`, `claimed:${b!.id}`, `attach:${b!.id}`]);
		expect(h.ctx.session).toBe(b!.session);
		expect(h.statuses.at(-1)).toBe(`Switched to conversation 2${TEACH}`);
		expect(shownWhenComposed.at(-1)).toEqual([`Switched to conversation 2${TEACH}`]);
	});

	/**
	 * The same failure as the motionless switch: the stage must not stay up
	 * over a conversation that never came, swallowing every key, with nothing
	 * said.
	 */
	it("a claim that throws lifts the stage, leaves the screen where it was and says why", async () => {
		const {
			h,
			a,
			peers: [b],
		} = openRoom({ name: "b", dir: dirB });
		b!.failNextPromptBuild();
		await h.room.switchTo(b!.id);
		await until(() => !h.room.viewOpen, "the stage to lift after the failed claim");
		expect(h.ctx.session).toBe(a.session);
		expect(h.errors.join("\n")).toContain(`prompt build failed for ${dirB}`);
	});

	it("a step after the attach that fails lands the stage on the new conversation, with a warning", async () => {
		const {
			h,
			peers: [b],
		} = openRoom({ name: "b", dir: dirB });
		h.failNextTodosReload("todo store unreadable");
		await h.room.switchTo(b!.id);
		await until(() => !h.room.viewOpen, "the stage to land");
		expect(h.ctx.session).toBe(b!.session);
		expect(h.errors).toEqual([]);
		expect(h.warnings).toEqual(["Switched, but the screen did not finish loading: todo store unreadable"]);
	});

	/**
	 * The stage opens with the composer's draft as the one on screen's; once
	 * the switch has moved the drafts, the conversation that arrived owns the
	 * composer. A stage that kept the old reading would draw the draft left in
	 * one conversation on the window of the one that arrived.
	 */
	it("each window keeps its own draft through the switch", async () => {
		const {
			h,
			a,
			peers: [b],
		} = openRoom({ name: "b", dir: dirB });
		h.ctx.editor.setText("draft for a");
		await h.room.switchTo(b!.id);
		await until(() => !h.room.viewOpen, "the stage to land");
		expect(Object.fromEntries(h.room.members().map(member => [member.id, member.draft]))).toEqual({
			[a.id]: { line: "draft for a", images: 0, files: 0 },
			[b!.id]: undefined,
		});
	});
});
