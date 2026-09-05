/**
 * WHY:
 * During startup, `paintFirstFrame` paints a live composer before the session,
 * model registry, or interactive mode exist. Keystrokes entered at that first
 * composer — such as `/settings\r` or a prompt `explain this\r` — arrive before
 * `InteractiveMode.init()` has wired its live submit handler.
 *
 * Previously, `#submitValue()` saw `!this.onSubmit` and silently discarded the Enter,
 * leaving the command sitting unsubmitted in the editor and forcing the user to press
 * Enter a second time.
 *
 * These tests defend the contract that:
 * 1. Prelaunch typing without Enter and prelaunch Enter before `settleQueuedInput`
 *    retain the draft and do NOT submit on handover.
 * 2. Postpaint early submissions (after `settleQueuedInput` installs `beginEarlySubmissions`)
 *    immediately clear editor text using ordinary editor semantics and queue early submissions.
 * 3. Relevant native submit bindings (plain Enter, Kitty protocol) and
 *    multiline paste expansions are captured and cleared immediately.
 * 4. Early prompt and slash command submissions followed by subsequent typing submit the former
 *    and preserve the latter across handover.
 * 5. Image-only early submissions and unsubmitted image-only drafts are captured and preserved.
 * 6. Async / delayed extension input handlers preserve subsequent drafts across processing.
 * 7. `InteractiveMode.init` dispatches early submissions without awaiting model-turn completion,
 *    allowing subsequent input to update the draft while the provider stream remains pending.
 * 8. Multiple early submissions retain FIFO dispatch ordering and distinct image attachments.
 * 9. Early slash commands (e.g. `/permissions`, `/settings`) execute real runtime actions
 *    upon handover.
 * 10. Extension-driven editor replacements during init (`setEditorComponent`) adopt pending
 *     early submissions, transfer draft images, and preserve in-progress typing.
 * 11. Actions and drafts entered during awaited asynchronous initialization hooks are captured
 *     as early submissions and dispatched once init completes.
 * 12. Provider stream failures during drain are handled gracefully without crashing `init`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import type { ImageContent } from "@veyyon/ai";
import { createMockModel, type MockModel, type MockResponse } from "@veyyon/ai/providers/mock";
import { KEYBINDINGS } from "@veyyon/coding-agent/config/keybinding-defs";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import {
	type ExtensionContext,
	ExtensionRunner,
	type InputEvent,
	type InputEventResult,
	type LoadedExtension,
} from "@veyyon/coding-agent/extensibility/extensions";
import { ExtensionRuntime } from "@veyyon/coding-agent/extensibility/extensions/loader";
import {
	CustomEditor,
	DEFERRED_EDITOR_ACTIONS,
	type DeferredEditorAction,
} from "@veyyon/coding-agent/modes/terminal/components/composer/custom-editor";
import { ModelPickerComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/model-picker";
import { paintFirstFrame, takeFirstFrame } from "@veyyon/coding-agent/modes/terminal/first-frame";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { USER_INTERRUPT_LABEL } from "@veyyon/coding-agent/session/messages";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { canonicalizeImageContent } from "@veyyon/coding-agent/utils/image-resize";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides, setAgentDir } from "@veyyon/utils/dirs";
import { resetKeybindingsForTests } from "@veyyon/utils/keybindings";
import type { KeyId } from "@veyyon/utils/keys";
import { YAML } from "bun";

const TINY_PNG_1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const TINY_PNG_2 =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP8z8Dwn4GBgQEADQUCAOAHawIAAAAASUVORK5CYII=";

describe("early first-frame actions are retained and executed", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let tempDir: TempDir;
	let savedGeometry: Record<"columns" | "rows", PropertyDescriptor | undefined>;
	let savedIsTTY: Record<"stdin" | "stdout", PropertyDescriptor | undefined>;
	let activeMode: InteractiveMode | undefined;
	let dirOverrides: DirOverridesSnapshot;

	async function writeIsolatedKeybindings(agentDir: string, config: Record<string, unknown>): Promise<void> {
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(path.join(agentDir, "keybindings.yml"), YAML.stringify(config, null, 2));
	}

	function keyIdToInput(keyId: string): string {
		if (keyId.startsWith("alt+")) {
			return `\x1b${keyId.slice(4)}`;
		}
		if (keyId.startsWith("ctrl+")) {
			const ch = keyId.slice(5);
			return String.fromCharCode(ch.toLowerCase().charCodeAt(0) & 31);
		}
		return keyId;
	}

	function sendInput(editor: { handleInput: (data: string) => void }, input: string): void {
		for (const ch of input) {
			editor.handleInput(ch);
		}
	}

	function actionShortcutInput(action: DeferredEditorAction): string {
		const defaultKey = [KEYBINDINGS[action].defaultKeys].flat()[0];
		if (defaultKey.startsWith("alt+")) {
			return `\x1b${defaultKey.slice(4)}`;
		}
		return defaultKey;
	}

	function getUserMessageContent(message: AgentMessage | undefined): { text: string; images: ImageContent[] } {
		if (message?.role !== "user") return { text: "", images: [] };
		if (typeof message.content === "string") return { text: message.content, images: [] };
		let text = "";
		const images: ImageContent[] = [];
		for (const part of message.content) {
			if (part.type === "text") text += part.text;
			else if (part.type === "image") images.push(part);
		}
		return { text, images };
	}

	function waitForIdle(sess: AgentSession): Promise<void> {
		if (!sess.isStreaming && sess.messages.some(m => m.role === "user")) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const unsubscribe = sess.subscribe(() => {
			if (!sess.isStreaming && sess.messages.some(m => m.role === "user")) {
				unsubscribe();
				resolve();
			}
		});
		return promise;
	}

	function waitForTurnCount(sess: AgentSession, targetCount: number): Promise<void> {
		if (sess.messages.filter(m => m.role === "user").length >= targetCount && !sess.isStreaming) {
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		const unsubscribe = sess.subscribe(() => {
			if (sess.messages.filter(m => m.role === "user").length >= targetCount && !sess.isStreaming) {
				unsubscribe();
				resolve();
			}
		});
		return promise;
	}

	function createExtensionWithInputHandler(
		handler: (event: InputEvent) => Promise<InputEventResult | undefined>,
	): ExtensionRunner {
		const ext: LoadedExtension = {
			path: "test-extension",
			manifest: { name: "test-extension" },
			handlers: new Map([["input", [handler as unknown as (event: unknown) => Promise<unknown>]]]),
			tools: new Map(),
			commands: new Map(),
			shortcuts: new Map(),
			flags: new Map(),
			sessionHooks: [],
			unresolvedSettings: [],
		} as unknown as LoadedExtension;

		return new ExtensionRunner(
			[ext],
			new ExtensionRuntime(),
			tempDir.path(),
			SessionManager.create(tempDir.path(), tempDir.path()),
			modelRegistry,
		);
	}

	function createExtensionWithSessionStart(
		handler: (event: unknown, ctx: ExtensionContext) => Promise<void>,
	): ExtensionRunner {
		const ext: LoadedExtension = {
			path: "test-extension",
			manifest: { name: "test-extension" },
			handlers: new Map([["session_start", [handler as unknown as (event: unknown) => Promise<unknown>]]]),
			tools: new Map(),
			commands: new Map(),
			shortcuts: new Map(),
			flags: new Map(),
			sessionHooks: [],
			unresolvedSettings: [],
		} as unknown as LoadedExtension;

		return new ExtensionRunner(
			[ext],
			new ExtensionRuntime(),
			tempDir.path(),
			SessionManager.create(tempDir.path(), tempDir.path()),
			modelRegistry,
		);
	}

	function createControlledSession(options?: {
		mock?: MockModel;
		extensionRunner?: ExtensionRunner;
		sessionManager?: SessionManager;
	}): {
		session: AgentSession;
		mock: MockModel;
	} {
		const mock = options?.mock ?? createMockModel({ responses: [{ content: ["Done"] }] });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 in registry");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});

		session = new AgentSession({
			agent,
			sessionManager: options?.sessionManager ?? SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
			extensionRunner: options?.extensionRunner,
		});

		return { session, mock };
	}

	function createMode(sess: AgentSession): InteractiveMode {
		const mode = new InteractiveMode(sess, "test", () => {}, [], undefined, new EventBus());
		activeMode = mode;
		vi.spyOn(mode.statusLine, "watchGitState").mockImplementation(() => {});
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
		return mode;
	}

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		savedGeometry = {
			columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
			rows: Object.getOwnPropertyDescriptor(process.stdout, "rows"),
		};
		savedIsTTY = {
			stdin: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
			stdout: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
		};
		Object.defineProperty(process.stdout, "columns", { value: 140, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 45, configurable: true });
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-early-submit-test-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("mock", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		dirOverrides = captureDirOverrides();
	});

	afterEach(async () => {
		if (activeMode) {
			activeMode.stop();
			activeMode = undefined;
		}
		const frame = takeFirstFrame();
		if (frame) {
			frame.release();
			frame.ui.stop();
		}
		await session?.dispose();
		authStorage?.close();
		for (const key of ["columns", "rows"] as const) {
			const descriptor = savedGeometry[key];
			if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
			else delete (process.stdout as unknown as Record<string, unknown>)[key];
		}
		for (const stream of ["stdin", "stdout"] as const) {
			const descriptor = savedIsTTY[stream];
			if (descriptor) Object.defineProperty(process[stream], "isTTY", descriptor);
			else delete (process[stream] as unknown as Record<string, unknown>).isTTY;
		}
		tempDir.removeSync();
		restoreDirOverrides(dirOverrides);
		resetKeybindingsForTests();
		vi.restoreAllMocks();
	});

	it("preserves typed draft without Enter before settleQueuedInput across handover without submitting", async () => {
		const frame = paintFirstFrame("1.3.0");
		sendInput(frame.editor, "drafting before settle");
		expect(await frame.settleQueuedInput()).toBe(true);
		expect(frame.editor.getText()).toBe("drafting before settle");
		expect(frame.editor.hasEarlySubmissions()).toBe(false);

		const { session: sess } = createControlledSession();
		const mode = createMode(sess);

		await mode.init();

		expect(sess.isStreaming).toBe(false);
		expect(sess.messages.length).toBe(0);
		expect(mode.editor.getText()).toBe("drafting before settle");
		expect(mode.editor.hasEarlySubmissions()).toBe(false);
	});

	it("retains draft when Enter is pressed before settleQueuedInput without submitting", async () => {
		const frame = paintFirstFrame("1.3.0");
		sendInput(frame.editor, "draft with enter before settle\r");
		expect(await frame.settleQueuedInput()).toBe(true);
		expect(frame.editor.getText()).toBe("draft with enter before settle");
		expect(frame.editor.hasEarlySubmissions()).toBe(false);

		const { session: sess } = createControlledSession();
		const mode = createMode(sess);

		await mode.init();

		expect(sess.isStreaming).toBe(false);
		expect(sess.messages.length).toBe(0);
		expect(mode.editor.getText()).toBe("draft with enter before settle");
		expect(mode.editor.hasEarlySubmissions()).toBe(false);
	});

	it("clears editor text immediately upon postpaint early submission and queues for handover", async () => {
		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();

		sendInput(frame.editor, "fix the bug\r");
		expect(frame.editor.getText()).toBe("");
		expect(frame.editor.hasEarlySubmissions()).toBe(true);

		const { session: sess } = createControlledSession();
		const mode = createMode(sess);

		await mode.init();
		await waitForIdle(sess);

		const userMsg = getUserMessageContent(sess.messages.find(m => m.role === "user"));
		expect(userMsg.text).toBe("fix the bug");
		expect(mode.editor.getText()).toBe("");
		expect(mode.editor.hasEarlySubmissions()).toBe(false);
	});

	it("clears editor text immediately on kitty protocol submit binding", async () => {
		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();
		frame.editor.handleInput("k");
		frame.editor.handleInput("i");
		frame.editor.handleInput("t");
		frame.editor.handleInput("t");
		frame.editor.handleInput("y");
		frame.editor.handleInput("\x1b[13;1u");
		expect(frame.editor.getText()).toBe("");
		expect(frame.editor.hasEarlySubmissions()).toBe(true);

		const { session: sess } = createControlledSession();
		const mode = createMode(sess);
		await mode.init();
		await waitForIdle(sess);
		expect(getUserMessageContent(sess.messages.find(m => m.role === "user")).text).toBe("kitty");
	});

	it("expands paste markers upon early submission and clears editor text immediately", async () => {
		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();

		const longPaste = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
		frame.editor.pasteText(longPaste);
		expect(frame.editor.getText()).toContain("[Paste #1, +15 lines]");

		sendInput(frame.editor, "\r");
		expect(frame.editor.getText()).toBe("");
		expect(frame.editor.hasEarlySubmissions()).toBe(true);

		const { session: sess } = createControlledSession();
		const mode = createMode(sess);

		await mode.init();
		await waitForIdle(sess);

		const userMsg = getUserMessageContent(sess.messages.find(m => m.role === "user"));
		expect(userMsg.text).toBe(longPaste);
	});

	it("submits early prompt and preserves subsequent draft typed before handover", async () => {
		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();

		sendInput(frame.editor, "first prompt\r");
		expect(frame.editor.getText()).toBe("");
		sendInput(frame.editor, "second draft in progress");
		expect(frame.editor.getText()).toBe("second draft in progress");
		expect(frame.editor.hasEarlySubmissions()).toBe(true);

		const { session: sess } = createControlledSession();
		const mode = createMode(sess);

		await mode.init();
		await waitForIdle(sess);

		const userMsg = getUserMessageContent(sess.messages.find(m => m.role === "user"));
		expect(userMsg.text).toBe("first prompt");
		expect(mode.editor.getText()).toBe("second draft in progress");
	});

	it("submits early /settings command and preserves subsequent draft typed before handover", async () => {
		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();

		sendInput(frame.editor, "/settings\r");
		expect(frame.editor.getText()).toBe("");
		expect(frame.editor.hasEarlySubmissions()).toBe(true);

		sendInput(frame.editor, "draft after early settings");
		expect(frame.editor.getText()).toBe("draft after early settings");

		const { session: sess } = createControlledSession();
		const mode = createMode(sess);
		const showSettingsSpy = vi.spyOn(mode, "showSettingsSelector");

		await mode.init();

		expect(showSettingsSpy).toHaveBeenCalledTimes(1);
		expect(mode.editor.getText()).toBe("draft after early settings");
		expect(mode.editor.hasEarlySubmissions()).toBe(false);
	});

	it("preserves unsubmitted image-only draft across handover of early submission", async () => {
		const draftImg = { type: "image" as const, mimeType: "image/png", data: TINY_PNG_1 };
		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();

		sendInput(frame.editor, "first prompt\r");
		expect(frame.editor.getText()).toBe("");
		expect(frame.editor.hasEarlySubmissions()).toBe(true);

		frame.editor.pendingImages.push(draftImg);
		frame.editor.pendingImageLinks.push("file://draft.png");
		expect(frame.editor.getText()).toBe("");
		expect(frame.editor.pendingImages).toEqual([draftImg]);

		const { session: sess } = createControlledSession();
		const mode = createMode(sess);

		await mode.init();
		await waitForIdle(sess);
		const submitted = getUserMessageContent(sess.messages.find(message => message.role === "user"));
		expect(submitted.text).toBe("first prompt");
		expect(submitted.images).toEqual([]);

		expect(mode.editor.getText()).toBe("");
		expect(mode.editor.pendingImages).toEqual([draftImg]);
		expect(mode.editor.pendingImageLinks).toEqual(["file://draft.png"]);
	});

	it("submits early image-only submission without text and dispatches with image attachment", async () => {
		const submittedImg = { type: "image" as const, mimeType: "image/png", data: TINY_PNG_1 };
		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();

		frame.editor.pendingImages.push(submittedImg);
		frame.editor.pendingImageLinks.push("file://submitted.png");
		sendInput(frame.editor, "\r");

		expect(frame.editor.getText()).toBe("");
		expect(frame.editor.pendingImages.length).toBe(0);
		expect(frame.editor.hasEarlySubmissions()).toBe(true);

		const { session: sess } = createControlledSession();
		const mode = createMode(sess);

		await mode.init();
		await waitForIdle(sess);

		const userMsg = getUserMessageContent(sess.messages.find(m => m.role === "user"));
		expect(userMsg.images).toHaveLength(1);
		expect(userMsg.images[0].type).toBe("image");
		expect(userMsg.images[0].data).toBeDefined();
	});

	it("preserves subsequent draft across delayed extension input handler processing early submission", async () => {
		const extensionPending = Promise.withResolvers<void>();
		const extensionRunner = createExtensionWithInputHandler(async event => {
			await extensionPending.promise;
			return { handled: false, text: `${event.text} (extended)` };
		});

		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();

		sendInput(frame.editor, "base prompt\r");
		expect(frame.editor.getText()).toBe("");

		sendInput(frame.editor, "draft while extension delayed");
		expect(frame.editor.getText()).toBe("draft while extension delayed");

		const { session: sess } = createControlledSession({ extensionRunner });
		const mode = createMode(sess);

		const initPromise = mode.init();
		extensionPending.resolve();
		await initPromise;
		await waitForIdle(sess);

		const userMsg = getUserMessageContent(sess.messages.find(m => m.role === "user"));
		expect(userMsg.text).toBe("base prompt (extended)");
		expect(mode.editor.getText()).toBe("draft while extension delayed");
	});

	it("preserves subsequent draft when extension input handler consumes early submission", async () => {
		const extensionRunner = createExtensionWithInputHandler(async () => ({ handled: true }));

		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();

		sendInput(frame.editor, "handled prompt\r");
		expect(frame.editor.getText()).toBe("");

		sendInput(frame.editor, "draft preserved when extension handles");
		expect(frame.editor.getText()).toBe("draft preserved when extension handles");

		const { session: sess } = createControlledSession({ extensionRunner });
		const mode = createMode(sess);

		await mode.init();

		expect(mode.editor.getText()).toBe("draft preserved when extension handles");
		expect(sess.messages.length).toBe(0);
	});

	it("resolves mode.init immediately while model turn remains pending on external provider stream, allowing live draft updates", async () => {
		const streamStarted = Promise.withResolvers<void>();
		const turnPending = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: async () => {
				streamStarted.resolve();
				await turnPending.promise;
				return { content: ["Algorithm explanation finished"] };
			},
		});

		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();
		sendInput(frame.editor, "explain this algorithm\r");
		expect(frame.editor.getText()).toBe("");

		const { session: sess } = createControlledSession({ mock });
		const mode = createMode(sess);

		// mode.init must resolve immediately without awaiting model-turn completion
		const initPromise = mode.init();
		await initPromise;

		await streamStarted.promise;
		expect(sess.isStreaming).toBe(true);

		// Draft input continues updating active editor during pending model stream
		sendInput(mode.editor, "follow-up drafted while model is streaming");
		expect(mode.editor.getText()).toBe("follow-up drafted while model is streaming");

		// Complete the external stream
		turnPending.resolve();
		await waitForIdle(sess);

		expect(sess.isStreaming).toBe(false);
		expect(mode.editor.getText()).toBe("follow-up drafted while model is streaming");

		const userMsg = getUserMessageContent(sess.messages.find(m => m.role === "user"));
		expect(userMsg.text).toBe("explain this algorithm");
	});

	it("preserves FIFO submission order, distinct attachments, and the subsequent draft", async () => {
		const img1 = { type: "image" as const, mimeType: "image/png", data: TINY_PNG_1 };
		const img2 = { type: "image" as const, mimeType: "image/png", data: TINY_PNG_2 };
		const img3 = { type: "image" as const, mimeType: "image/png", data: TINY_PNG_1 };

		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();

		// 1. First early submission
		frame.editor.pendingImages.push(img1);
		frame.editor.pendingImageLinks.push("file://first.png");
		sendInput(frame.editor, "first submit\r");
		expect(frame.editor.getText()).toBe("");

		// 2. Second early submission
		frame.editor.pendingImages.push(img2);
		frame.editor.pendingImageLinks.push("file://second.png");
		sendInput(frame.editor, "second submit\r");
		expect(frame.editor.getText()).toBe("");

		// 3. Third unsubmitted draft in progress with img3
		frame.editor.pendingImages.push(img3);
		frame.editor.pendingImageLinks.push("file://3.webp");
		sendInput(frame.editor, "third unsubmitted draft");
		expect(frame.editor.getText()).toBe("third unsubmitted draft");
		expect(frame.editor.pendingImages).toEqual([img3]);

		const mock = createMockModel({
			responses: [{ content: ["First response"] }, { content: ["Second response"] }],
		});
		const { session: sess } = createControlledSession({ mock });
		const mode = createMode(sess);

		await mode.init();

		// Active editor retains unsubmitted draft and its isolated attachment
		expect(mode.editor.getText()).toBe("third unsubmitted draft");
		expect(mode.editor.pendingImages).toEqual([img3]);
		expect(mode.editor.pendingImageLinks).toEqual(["file://3.webp"]);

		// Wait for both early submissions to complete through session
		await waitForTurnCount(sess, 2);

		const userMessages = sess.messages.filter(m => m.role === "user").map(getUserMessageContent);
		expect(userMessages).toHaveLength(2);
		expect(userMessages[0].text).toBe("first submit");
		expect(userMessages[1].text).toBe("second submit");
		expect(userMessages.map(message => message.images.length)).toEqual([1, 1]);
		const delivered = await Promise.all(userMessages.map(message => canonicalizeImageContent(message.images[0])));
		// Provider preprocessing upscales tiny images while preserving their aspect ratios.
		expect(delivered.map(image => image.width / image.height)).toEqual([1, 2]);
	});

	it("executes actual slash commands (/permissions, /settings) upon handover and clears draft", async () => {
		// 1. /permissions auto
		const frame1 = paintFirstFrame("1.3.0");
		await frame1.settleQueuedInput();
		sendInput(frame1.editor, "/permissions auto\r");
		expect(frame1.editor.getText()).toBe("");
		expect(frame1.editor.hasEarlySubmissions()).toBe(true);

		const { session: sess1 } = createControlledSession();
		const mode1 = createMode(sess1);
		await mode1.init();

		expect(sess1.settings.get("tools.approvalMode")).toBe("auto");
		expect(mode1.editor.getText()).toBe("");
		expect(mode1.editor.hasEarlySubmissions()).toBe(false);
		mode1.stop();
		activeMode = undefined;

		// 2. /settings
		const frame2 = paintFirstFrame("1.3.0");
		await frame2.settleQueuedInput();
		sendInput(frame2.editor, "/settings\r");
		expect(frame2.editor.getText()).toBe("");
		expect(frame2.editor.hasEarlySubmissions()).toBe(true);

		const { session: sess2 } = createControlledSession();
		const mode2 = createMode(sess2);
		const showSettingsSpy = vi.spyOn(mode2, "showSettingsSelector");
		await mode2.init();

		expect(showSettingsSpy).toHaveBeenCalledTimes(1);
		expect(mode2.editor.getText()).toBe("");
		expect(mode2.editor.hasEarlySubmissions()).toBe(false);
	});

	it("adopts early submissions, transfers pending images, and preserves draft when an extension replaces editor component during init", async () => {
		const draftImg = { type: "image" as const, mimeType: "image/png", data: TINY_PNG_1 };
		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();

		// Early submission before init
		sendInput(frame.editor, "early prompt before editor replacement\r");
		expect(frame.editor.getText()).toBe("");
		expect(frame.editor.hasEarlySubmissions()).toBe(true);

		// In-progress draft and image attachment before replacement
		frame.editor.pendingImages.push(draftImg);
		frame.editor.pendingImageLinks.push("file://draft.png");
		sendInput(frame.editor, "draft before replacement");
		expect(frame.editor.getText()).toBe("draft before replacement");
		expect(frame.editor.pendingImages).toEqual([draftImg]);

		let replacementEditor: CustomEditor | undefined;
		const extensionRunner = createExtensionWithSessionStart(async (_event, ctx) => {
			ctx.ui.terminal?.setEditorComponent((_tui, theme) => {
				replacementEditor = new CustomEditor(theme);
				return replacementEditor;
			});
		});

		const { session: sess } = createControlledSession({ extensionRunner });
		const mode = createMode(sess);

		await mode.init();

		expect(replacementEditor).toBeDefined();
		expect(mode.editor).toBe(replacementEditor!);
		expect(mode.editor.getText()).toBe("draft before replacement");
		expect(mode.editor.pendingImages).toEqual([draftImg]);
		expect(mode.editor.pendingImageLinks).toEqual(["file://draft.png"]);

		await waitForIdle(sess);

		const userMsg = getUserMessageContent(sess.messages.find(m => m.role === "user"));
		expect(userMsg.text).toBe("early prompt before editor replacement");
		expect(mode.editor.getText()).toBe("draft before replacement");
		expect(mode.editor.pendingImages).toEqual([draftImg]);
	});

	it("captures early submissions entered during awaited initialization hook and executes them upon init completion", async () => {
		const hookStarted = Promise.withResolvers<void>();
		const hookRelease = Promise.withResolvers<void>();

		const extensionRunner = createExtensionWithSessionStart(async () => {
			hookStarted.resolve();
			await hookRelease.promise;
		});

		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();

		const { session: sess } = createControlledSession({ extensionRunner });
		const mode = createMode(sess);

		const initPromise = mode.init();

		// Wait until interactive mode is in the middle of initHooksAndCustomTools()
		await hookStarted.promise;

		// Enter an action + submit AND a follow-up draft during the awaited initialization hook
		sendInput(mode.editor, "action submitted during init hook\r");
		expect(mode.editor.getText()).toBe("");
		expect(mode.editor.hasEarlySubmissions()).toBe(true);

		sendInput(mode.editor, "draft entered during init hook");
		expect(mode.editor.getText()).toBe("draft entered during init hook");

		// Release the initialization hook so mode.init completes
		hookRelease.resolve();
		await initPromise;
		await waitForIdle(sess);

		const userMsg = getUserMessageContent(sess.messages.find(m => m.role === "user"));
		expect(userMsg.text).toBe("action submitted during init hook");
		expect(mode.editor.getText()).toBe("draft entered during init hook");
		expect(mode.editor.hasEarlySubmissions()).toBe(false);
	});

	it("ignores empty Enter and leaves composer empty without queueing early submissions", async () => {
		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();

		sendInput(frame.editor, "\r");
		expect(frame.editor.getText()).toBe("");
		expect(frame.editor.hasEarlySubmissions()).toBe(false);

		const { session: sess } = createControlledSession();
		const mode = createMode(sess);

		await mode.init();

		expect(sess.isStreaming).toBe(false);
		expect(sess.messages.length).toBe(0);
		expect(mode.editor.getText()).toBe("");
	});

	it("handles provider stream failure during early submission drain gracefully without crashing init", async () => {
		const mock = createMockModel({
			handler: async () => {
				throw new Error("External provider network failure");
			},
		});

		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();
		sendInput(frame.editor, "failing prompt\r");
		expect(frame.editor.getText()).toBe("");

		const { session: sess } = createControlledSession({ mock });
		const mode = createMode(sess);

		await mode.init();
		await waitForIdle(sess);

		expect(sess.isStreaming).toBe(false);
		const failure = sess.messages.findLast(message => message.role === "assistant");
		expect(failure?.stopReason).toBe("error");
		expect(failure?.errorMessage).toContain("External provider network failure");
	});

	for (const action of DEFERRED_EDITOR_ACTIONS) {
		it(`retains postpaint ${action} shortcut before init and opens real selector after init with draft preserved`, async () => {
			const draftImg = { type: "image" as const, mimeType: "image/png", data: TINY_PNG_1 };
			const frame = paintFirstFrame("1.3.0");
			await frame.settleQueuedInput();

			const shortcut = actionShortcutInput(action);
			frame.editor.handleInput(shortcut);
			expect(frame.editor.hasEarlyActions()).toBe(true);

			// Subsequent draft and attachment typed after shortcut before init
			frame.editor.pendingImages.push(draftImg);
			frame.editor.pendingImageLinks.push("file://test-draft.png");
			sendInput(frame.editor, "draft after selector shortcut");
			expect(frame.editor.getText()).toBe("draft after selector shortcut");
			expect(frame.editor.pendingImages).toEqual([draftImg]);

			const { session: sess } = createControlledSession();
			const mode = createMode(sess);

			await mode.init();

			// Real selector overlay is open and focused
			const focused = mode.ui.getFocused();
			expect(focused).toBeInstanceOf(ModelPickerComponent);
			expect(mode.editor.hasEarlyActions()).toBe(false);

			// Close the selector via Escape
			focused?.handleInput?.("\x1b");

			// Focus returns to editor, draft text and image attachments remain intact
			expect(mode.ui.getFocused()).toBe(mode.editor);
			expect(mode.editor.getText()).toBe("draft after selector shortcut");
			expect(mode.editor.pendingImages).toEqual([draftImg]);
			expect(mode.editor.pendingImageLinks).toEqual(["file://test-draft.png"]);

			// Selector was opened exactly once and does not reopen on subsequent ticks/Escapes
			expect(mode.ui.getFocused()).toBe(mode.editor);

			// Normal shortcut execution after init works as expected
			mode.editor.handleInput(shortcut);
			expect(mode.ui.getFocused()).toBeInstanceOf(ModelPickerComponent);
			mode.ui.getFocused()?.handleInput?.("\x1b");
			expect(mode.ui.getFocused()).toBe(mode.editor);
		});
	}

	it("does not capture model selector shortcut as early action when entered before settleQueuedInput", async () => {
		const frame = paintFirstFrame("1.3.0");
		const shortcut = actionShortcutInput("app.model.select");
		frame.editor.handleInput(shortcut);

		expect(await frame.settleQueuedInput()).toBe(false);
		expect(frame.editor.hasEarlyActions()).toBe(false);

		const { session: sess } = createControlledSession();
		const mode = createMode(sess);

		await mode.init();

		expect(mode.ui.getFocused()).toBe(mode.editor);
		expect(mode.editor.hasEarlyActions()).toBe(false);
	});

	it("adopts pending early selector actions when an extension replaces editor component during init", async () => {
		const draftImg = { type: "image" as const, mimeType: "image/png", data: TINY_PNG_1 };
		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();

		// Early selector action before init
		frame.editor.handleInput(actionShortcutInput("app.model.selectTemporary"));
		expect(frame.editor.hasEarlyActions()).toBe(true);

		frame.editor.pendingImages.push(draftImg);
		sendInput(frame.editor, "draft before replacement with selector");

		let replacementEditor: CustomEditor | undefined;
		const extensionRunner = createExtensionWithSessionStart(async (_event, ctx) => {
			ctx.ui.terminal?.setEditorComponent((_tui, theme) => {
				replacementEditor = new CustomEditor(theme);
				return replacementEditor;
			});
		});

		const { session: sess } = createControlledSession({ extensionRunner });
		const mode = createMode(sess);

		await mode.init();

		expect(replacementEditor).toBeDefined();
		expect(mode.editor).toBe(replacementEditor!);
		expect(mode.ui.getFocused()).toBeInstanceOf(ModelPickerComponent);

		mode.ui.getFocused()?.handleInput?.("\x1b");
		expect(mode.ui.getFocused()).toBe(mode.editor);
		expect(replacementEditor!.getText()).toBe("draft before replacement with selector");
		expect(replacementEditor!.pendingImages).toEqual([draftImg]);
	});

	it("dispatches early submission and deferred selector shortcut without awaiting model turn", async () => {
		const streamStarted = Promise.withResolvers<void>();
		const turnPending = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: async () => {
				streamStarted.resolve();
				await turnPending.promise;
				return { content: ["Response finished"] };
			},
		});

		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();

		sendInput(frame.editor, "early prompt\r");
		frame.editor.handleInput(actionShortcutInput("app.model.select"));
		sendInput(frame.editor, "draft while streaming");

		const { session: sess } = createControlledSession({ mock });
		const mode = createMode(sess);

		await mode.init();

		// Stream started without blocking mode.init()
		await streamStarted.promise;
		expect(sess.isStreaming).toBe(true);

		// Model selector is open and focused
		expect(mode.ui.getFocused()).toBeInstanceOf(ModelPickerComponent);

		// Dismiss selector and verify draft and typing progression
		mode.ui.getFocused()?.handleInput?.("\x1b");
		expect(mode.ui.getFocused()).toBe(mode.editor);
		expect(mode.editor.getText()).toBe("draft while streaming");

		sendInput(mode.editor, " more typing");
		expect(mode.editor.getText()).toBe("draft while streaming more typing");

		turnPending.resolve();
		await waitForIdle(sess);

		expect(sess.isStreaming).toBe(false);
		const userMsg = getUserMessageContent(sess.messages.find(m => m.role === "user"));
		expect(userMsg.text).toBe("early prompt");
		expect(mode.editor.getText()).toBe("draft while streaming more typing");
	});

	it("executes real model selection when deferred selector action is picked", async () => {
		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();

		frame.editor.handleInput(actionShortcutInput("app.model.selectTemporary"));

		const { session: sess } = createControlledSession();
		const mode = createMode(sess);

		await mode.init();

		const picker = mode.ui.getFocused();
		expect(picker).toBeInstanceOf(ModelPickerComponent);

		const {
			promise: focusReturned,
			resolve: onFocusReturned,
			reject: onFocusTimeout,
		} = Promise.withResolvers<void>();
		const startCheckTime = Date.now();
		const timeoutMs = 2000;
		const checkFocus = () => {
			if (mode.ui.getFocused() === mode.editor) {
				onFocusReturned();
			} else if (Date.now() - startCheckTime > timeoutMs) {
				onFocusTimeout(new Error(`Focus did not return to editor within ${timeoutMs}ms`));
			} else {
				setImmediate(checkFocus);
			}
		};

		// Select the model in picker by sending enter
		picker?.handleInput?.("\r");
		checkFocus();
		await focusReturned;
		// Picker closed and returned focus to editor
		expect(mode.ui.getFocused()).toBe(mode.editor);
		expect(sess.model?.id).toBe("claude-sonnet-4-5");
	});

	it("cancels streaming early submission on Escape while preserving live draft typed during stream", async () => {
		const streamStarted = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: (_context, options) => {
				streamStarted.resolve();
				const { promise, resolve } = Promise.withResolvers<MockResponse>();
				options?.signal?.addEventListener("abort", () => {
					resolve({ stopReason: "aborted", errorMessage: USER_INTERRUPT_LABEL });
				});
				return promise;
			},
		});

		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();
		sendInput(frame.editor, "early prompt to cancel\r");
		expect(frame.editor.getText()).toBe("");

		const { session: sess } = createControlledSession({ mock });
		const mode = createMode(sess);

		await mode.init();
		await streamStarted.promise;
		expect(sess.isStreaming).toBe(true);

		// User enters follow-up draft while stream is active
		sendInput(mode.editor, "draft while stream active");
		expect(mode.editor.getText()).toBe("draft while stream active");

		mode.editor.handleInput("\x1b");
		await waitForIdle(sess);

		expect(sess.isStreaming).toBe(false);
		const assistantMsg = sess.messages.findLast(m => m.role === "assistant");
		expect(assistantMsg?.stopReason).toBe("aborted");
		expect(mode.editor.getText()).toBe("draft while stream active");
	});

	it("restores unsent draft on resume from disk when no early submission was entered", async () => {
		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();

		const sessionDir = path.join(tempDir.path(), "disk-sessions-1");
		const sessionManager1 = SessionManager.create(tempDir.path(), sessionDir);
		await sessionManager1.saveDraft("saved unsent draft text on disk");
		const sessionFile = sessionManager1.getSessionFile()!;

		const sessionManager2 = await SessionManager.open(sessionFile, sessionDir);
		const { session: sess } = createControlledSession({ sessionManager: sessionManager2 });

		const mode = createMode(sess);
		await mode.init();

		expect(sess.isStreaming).toBe(false);
		expect(sess.messages.length).toBe(0);
		expect(mode.editor.getText()).toBe("saved unsent draft text on disk");
		expect(mode.editor.hasEarlySubmissions()).toBe(false);
	});

	it("preserves both early submission and disk-restored unsent draft on resume", async () => {
		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();

		sendInput(frame.editor, "early prompt on resume\r");
		expect(frame.editor.getText()).toBe("");
		expect(frame.editor.hasEarlySubmissions()).toBe(true);

		const sessionDir = path.join(tempDir.path(), "disk-sessions-2");
		const sessionManager1 = SessionManager.create(tempDir.path(), sessionDir);
		await sessionManager1.saveDraft("restored draft on resume from disk");
		const sessionFile = sessionManager1.getSessionFile()!;

		const sessionManager2 = await SessionManager.open(sessionFile, sessionDir);
		const { session: sess } = createControlledSession({ sessionManager: sessionManager2 });

		const mode = createMode(sess);
		await mode.init();
		await waitForIdle(sess);

		expect(sess.isStreaming).toBe(false);
		const userMsg = getUserMessageContent(sess.messages.find(m => m.role === "user"));
		expect(userMsg.text).toBe("early prompt on resume");
		expect(mode.editor.getText()).toBe("restored draft on resume from disk");
	});

	for (const action of DEFERRED_EDITOR_ACTIONS) {
		it(`honors real isolated keybindings.yml reassignment for ${action} during early startup and rejects default chord`, async () => {
			const agentDir = path.join(tempDir.path(), `agent-${action.replace(/\./g, "-")}`);
			setAgentDir(agentDir);

			// Choose a custom chord distinctly different from default
			const customKey = action === "app.model.select" ? "ctrl+y" : "ctrl+k";
			const defaultKey = [KEYBINDINGS[action].defaultKeys].flat()[0];

			await writeIsolatedKeybindings(agentDir, {
				[action]: customKey,
			});

			const draftImg = { type: "image" as const, mimeType: "image/png", data: TINY_PNG_1 };
			const frame = paintFirstFrame("1.3.0");
			await frame.settleQueuedInput();

			// 1. Manager is configured from disk
			expect(frame.keybindings.getKeys(action)).toEqual([customKey as KeyId]);

			// 2. Default chord is rejected (does not capture early action and does not crash)
			const defaultInput = keyIdToInput(defaultKey);
			frame.editor.handleInput(defaultInput);
			expect(frame.editor.hasEarlyActions()).toBe(false);

			// Reset any text typed by rejected default chord
			frame.editor.setText("");

			// 3. Draft typing & image before the custom chord
			sendInput(frame.editor, "pre-chord draft ");
			frame.editor.pendingImages.push(draftImg);
			frame.editor.pendingImageLinks.push("file://test-draft.png");

			// 4. Send custom chord
			const customInput = keyIdToInput(customKey);
			frame.editor.handleInput(customInput);
			expect(frame.editor.hasEarlyActions()).toBe(true);

			// 5. Subsequent typing after custom chord
			sendInput(frame.editor, "post-chord draft");

			expect(frame.editor.getText()).toBe("pre-chord draft post-chord draft");
			expect(frame.editor.pendingImages).toEqual([draftImg]);
			expect(frame.editor.pendingImageLinks).toEqual(["file://test-draft.png"]);

			// 6. InteractiveMode init adopts first-frame and reuses manager
			const { session: sess } = createControlledSession();
			const mode = createMode(sess);

			await mode.init();

			expect(mode.keybindings).toBe(frame.keybindings);
			expect(mode.editor.hasEarlyActions()).toBe(false);

			// 7. Selector opens and is focused
			const focused = mode.ui.getFocused();
			expect(focused).toBeInstanceOf(ModelPickerComponent);

			// 8. Close selector with Escape
			focused?.handleInput?.("\x1b");

			// 9. Focus returns to editor, draft text and attachments intact
			expect(mode.ui.getFocused()).toBe(mode.editor);
			expect(mode.editor.getText()).toBe("pre-chord draft post-chord draft");
			expect(mode.editor.pendingImages).toEqual([draftImg]);
			expect(mode.editor.pendingImageLinks).toEqual(["file://test-draft.png"]);

			// 10. Does not reopen on subsequent ticks
			expect(mode.ui.getFocused()).toBe(mode.editor);
		});

		it(`does not fire ${action} as early action when disabled in keybindings.yml`, async () => {
			const agentDir = path.join(tempDir.path(), `agent-disabled-${action.replace(/\./g, "-")}`);
			setAgentDir(agentDir);
			await writeIsolatedKeybindings(agentDir, {
				[action]: [],
			});

			const defaultKey = [KEYBINDINGS[action].defaultKeys].flat()[0];
			const frame = paintFirstFrame("1.3.0");
			await frame.settleQueuedInput();

			expect(frame.keybindings.getKeys(action)).toEqual([]);

			// Default chord should not trigger early action
			const defaultInput = keyIdToInput(defaultKey);
			frame.editor.handleInput(defaultInput);
			expect(frame.editor.hasEarlyActions()).toBe(false);

			const { session: sess } = createControlledSession();
			const mode = createMode(sess);

			await mode.init();

			expect(mode.ui.getFocused()).toBe(mode.editor);
			expect(mode.editor.hasEarlyActions()).toBe(false);
		});
	}

	it("migrates legacy keybinding names from keybindings.yml and captures early selector action", async () => {
		const agentDir = path.join(tempDir.path(), "agent-legacy");
		setAgentDir(agentDir);

		await writeIsolatedKeybindings(agentDir, {
			selectModel: "ctrl+y",
		});

		const frame = paintFirstFrame("1.3.0");
		await frame.settleQueuedInput();

		expect(frame.keybindings.getKeys("app.model.select")).toEqual(["ctrl+y"]);

		frame.editor.handleInput(keyIdToInput("ctrl+y"));
		expect(frame.editor.hasEarlyActions()).toBe(true);

		const { session: sess } = createControlledSession();
		const mode = createMode(sess);

		await mode.init();

		expect(mode.ui.getFocused()).toBeInstanceOf(ModelPickerComponent);
		mode.ui.getFocused()?.handleInput?.("\x1b");
		expect(mode.ui.getFocused()).toBe(mode.editor);
	});
});
