/**
 * WHY:
 *
 * The terminal has dictated into its composer since `app.stt.toggle` existed:
 * `STTController` drives the editor directly, inserting segments, showing the
 * phrase in flight as volatile text, trimming a spoken submit phrase and
 * sending the turn. The desktop had no projection of any of it, so a window
 * was the one surface where speech could not reach the composer at all.
 *
 * The class this closes: a capability the terminal reaches through a
 * controller that writes into its own editor, which cannot cross the wire
 * because the host holds no draft. The bridge translates the controller's
 * editor calls into a view of what has been heard; the window keeps the draft
 * and rewrites the field from it.
 *
 * This suite defends:
 * 1. Every editor call the controller makes reaches the view: an inserted
 *    batch transcription, a partial replaced by its commit, a trimmed submit
 *    phrase, and the submit flag.
 * 2. Each committed change raises the revision exactly once, so the window
 *    applies it once.
 * 3. A cancel closes the microphone and discards what was heard, whether or
 *    not any words arrived first, and the next dictation reaches a controller
 *    that was never torn down. `dispose` is terminal -- a disposed controller
 *    returns early from every partial, segment and state callback -- so both
 *    a bridge that kept the disposed one and a cancel that reads the words to
 *    decide whether to close the microphone fail in silence, with the toggle
 *    still resolving and the recorder still open.
 * 4. The host refuses to open a microphone while `stt.enabled` is off, before
 *    provisioning a recorder or downloading a model, and states which setting
 *    to turn on. The refusal holds on a connection made before this process
 *    loaded settings, where the capability list is answered from the declared
 *    default rather than from a store.
 * 5. Disposing the client closes the microphone and opens no other.
 *
 * Each branch above was mutation-gated: fifteen single-line defects across the
 * bridge, the capability list and the two action handlers, including the two
 * the first draft of this suite missed, and every one turns it red.
 *
 * What it does NOT catch: the recogniser itself, the recorder, and the model
 * download, which need a microphone and a network. Those are `STTController`'s
 * own, and the seam here is the editor slice it drives. A stand-in for
 * `toggle` answers whether it was disposed or not, which is why disposal runs
 * for real here and the assertion names which controller a toggle reached.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { DesktopDictationBridge } from "../../src/gui-host/dictation-bridge";
import type { DictationView, SnapshotSection } from "../../src/gui-host/wire";
import * as controllerModule from "../../src/speech/stt/stt-controller";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { snapshotSections, TestSocketClient } from "./test-client";

/** The slice of the composer `STTController` drives, as the bridge hands it over. */
interface CapturedEditor {
	insertText(text: string): void;
	setVolatileText(text: string): void;
	clearVolatileText(): void;
	commitVolatileText(text: string): void;
	submit(): void;
	deleteBeforeCursor(count: number): void;
}

/** The callbacks `STTController` reports through, as the bridge hands them over. */
interface CapturedOptions {
	showWarning(message: string): void;
	showStatus(message: string): void;
	onStateChange(state: controllerModule.SttState): void;
	requestRender?(): void;
}

interface Dictating {
	bridge: DesktopDictationBridge;
	sections: DictationView[];
	editor: CapturedEditor;
	options: CapturedOptions;
	/** The controller each `toggle` reached, in call order. */
	toggled: controllerModule.STTController[];
	/** The controller each `dispose` reached, in call order. Disposal runs for real. */
	disposed: controllerModule.STTController[];
}

/**
 * A bridge whose recogniser is replaced by the test, which then makes the
 * editor calls a real recognition would make.
 *
 * The microphone and the speech model are the one boundary this cannot run.
 * Everything between the controller's editor slice and the frame the window
 * decodes is the real code.
 *
 * `toggle` is the stand-in, and it records which controller it was called on.
 * A stand-in answers whether it was disposed or not, so a test that only
 * called it would report a dictation as working on a controller that a real
 * recogniser had already torn down. `dispose` runs for real and is recorded
 * beside it, which is what makes "this toggle reached a live controller" an
 * assertion rather than a restatement of the mock.
 */
async function dictating(): Promise<Dictating> {
	const sections: DictationView[] = [];
	const toggled: controllerModule.STTController[] = [];
	const disposed: controllerModule.STTController[] = [];
	let editor: CapturedEditor | undefined;
	let options: CapturedOptions | undefined;
	spyOn(controllerModule.STTController.prototype, "toggle").mockImplementation(async function (
		this: controllerModule.STTController,
		editorArg: unknown,
		optionsArg: unknown,
	) {
		toggled.push(this);
		editor = editorArg as CapturedEditor;
		options = optionsArg as CapturedOptions;
	});
	const realDispose = controllerModule.STTController.prototype.dispose;
	spyOn(controllerModule.STTController.prototype, "dispose").mockImplementation(function (
		this: controllerModule.STTController,
	) {
		disposed.push(this);
		realDispose.call(this);
	});
	const bridge = new DesktopDictationBridge(undefined, (section: SnapshotSection) => {
		if ("Dictation" in section) sections.push(section.Dictation);
	});
	await bridge.toggle();
	expect(toggled.length).toBe(1);
	if (!editor || !options) throw new Error("the bridge never handed the controller an editor");
	return { bridge, sections, editor, options, toggled, disposed };
}

describe("a window dictates into its own composer", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("a batch transcription reaches the view as the words it heard", async () => {
		const { bridge, sections, editor, options } = await dictating();
		options.onStateChange("recording");
		options.onStateChange("transcribing");
		editor.insertText("ship the desktop parity work");
		options.onStateChange("idle");

		expect(bridge.view().utterance).toBe("ship the desktop parity work");
		expect(bridge.view().state).toBe("idle");
		expect(sections.at(-1)?.utterance).toBe("ship the desktop parity work");
	});

	test("a phrase in flight is held apart from the words already committed", async () => {
		const { bridge, editor } = await dictating();
		editor.setVolatileText("ship the");
		expect(bridge.view()).toMatchObject({ utterance: "", partial: "ship the" });

		editor.commitVolatileText("ship the desktop");
		expect(bridge.view()).toMatchObject({ utterance: "ship the desktop", partial: "" });

		editor.setVolatileText(" parity work");
		expect(bridge.view()).toMatchObject({
			utterance: "ship the desktop",
			partial: " parity work",
		});
	});

	test("a spoken submit phrase is trimmed off the words and sends the turn", async () => {
		const { bridge, editor } = await dictating();
		editor.commitVolatileText("ship it send message");
		editor.deleteBeforeCursor(" send message".length);
		editor.submit();

		expect(bridge.view().utterance).toBe("ship it");
		expect(bridge.view().submit).toBeTrue();
	});

	test("a trim longer than what was dictated empties the words rather than reaching past them", async () => {
		const { bridge, editor } = await dictating();
		editor.commitVolatileText("send");
		editor.deleteBeforeCursor(99);

		expect(bridge.view().utterance).toBe("");
	});

	test("each committed change raises the revision exactly once", async () => {
		const { sections, editor, options } = await dictating();
		const before = sections.length;
		options.onStateChange("recording");
		editor.setVolatileText("one");
		editor.commitVolatileText("one");

		const raised = sections.slice(before).map(view => view.revision);
		expect(raised.length).toBe(3);
		expect(raised).toEqual([raised[0], raised[0] + 1, raised[0] + 2]);
	});

	test("a warning is stated on the view rather than only logged", async () => {
		const { bridge, options } = await dictating();
		options.showWarning("No recorder found on PATH");

		expect(bridge.view().error).toBe("No recorder found on PATH");
	});

	test("a status is stated while it lasts and cleared by the empty string", async () => {
		const { bridge, options } = await dictating();
		options.showStatus("Downloading speech model base (40%)");
		expect(bridge.view().status).toBe("Downloading speech model base (40%)");

		options.showStatus("");
		expect(bridge.view().status).toBeNull();
	});

	test("a cancel discards what was heard and dictates again on a controller that is not torn down", async () => {
		const { bridge, sections, editor, toggled, disposed } = await dictating();
		editor.commitVolatileText("scratch that");

		bridge.cancel();
		expect(disposed).toEqual([toggled[0]]);
		expect(bridge.view()).toMatchObject({ state: "idle", utterance: "", partial: "" });
		expect(sections.at(-1)?.utterance).toBe("");

		// Disposal is terminal: a disposed controller returns early from every
		// partial, segment and state callback, so a bridge that kept it would
		// open no microphone and report nothing, with the toggle still
		// resolving. Asserting the state after the toggle cannot see that;
		// asserting which controller the toggle reached can.
		await bridge.toggle();
		expect(toggled.length).toBe(2);
		expect(disposed).not.toContain(toggled[1]);
	});

	test("a cancel closes a microphone that has heard nothing yet", async () => {
		const { bridge, options, toggled, disposed } = await dictating();
		options.onStateChange("recording");

		// Nothing has been heard, so every text field is already empty. The
		// microphone is open regardless, and reading the words to decide
		// whether to close it would leave it recording until the window shut.
		bridge.cancel();
		expect(disposed).toEqual([toggled[0]]);
		expect(bridge.view().state).toBe("idle");
	});

	test("a cancel with no dictation open opens and tears down nothing", async () => {
		const { bridge, sections, disposed } = await dictating();
		const before = sections.length;

		bridge.cancel();
		expect(disposed).toEqual([]);
		expect(sections.length).toBe(before);
	});

	test("a fresh dictation starts from empty rather than resending the last one", async () => {
		const { bridge, editor } = await dictating();
		editor.commitVolatileText("first");
		editor.submit();
		expect(bridge.view()).toMatchObject({ utterance: "first", submit: true });

		await bridge.toggle();
		expect(bridge.view()).toMatchObject({ utterance: "", submit: false });
	});

	test("disposing the bridge closes the microphone and opens no other", async () => {
		const { bridge, toggled, disposed } = await dictating();

		bridge.dispose();
		expect(disposed).toEqual([toggled[0]]);
		expect(bridge.state).toBe("idle");

		// Unlike a cancel, this window is gone: a later toggle provisions no
		// recorder rather than replacing the controller.
		await bridge.toggle();
		expect(toggled.length).toBe(1);
	});
});

describe("a host with speech to text off opens no microphone", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-dictation-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (server) {
			await server.close();
			server = null;
		}
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	test("the toggle is refused naming the setting, and the controller is never reached", async () => {
		const toggle = spyOn(controllerModule.STTController.prototype, "toggle");
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir });
		const client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();

		const { outcome } = await client.request(1, "ToggleDictation");
		expect(outcome.RequestFailed?.error.code).toBe("DICTATION_DISABLED");
		expect(outcome.RequestFailed?.error.message).toContain("stt.enabled");
		expect(toggle).not.toHaveBeenCalled();

		client.destroy();
	});

	test("the capability states the setting that withholds it", async () => {
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir });
		const client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		const capabilities = (await client.nextFrame()) as {
			Snapshot: { Capabilities: [string, string | { Unavailable: { reason: string } }][] };
		};
		const status = new Map(capabilities.Snapshot.Capabilities).get("Dictation");

		expect(status).toEqual({
			Unavailable: { reason: "Speech to text is disabled in settings (stt.enabled)" },
		});

		client.destroy();
	});

	test("a cancel is answered even with the setting off, so a running microphone can be closed", async () => {
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir });
		const client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();

		const { outcome } = await client.request(1, "CancelDictation");
		expect(outcome).toEqual({ RequestSucceeded: { request: 1 } });

		client.destroy();
	});
});

describe("a host with speech to text on offers the microphone", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let state: SettingsTestState | undefined;

	beforeEach(async () => {
		state = beginSettingsTest();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-dictation-on-"));
		await fs.writeFile(path.join(tempDir, "config.yml"), "stt:\n  enabled: true\n", "utf8");
		// Startup fills the process store before a window connects, and the
		// capability frame is written from the connection listener. A test that
		// skipped this would read the off arm's answer with the setting on.
		await Settings.init({ cwd: tempDir, agentDir: tempDir });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (server) {
			await server.close();
			server = null;
		}
		restoreSettingsTestState(state);
		state = undefined;
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	test("the capability is offered and the toggle reaches the recogniser", async () => {
		// Stubbed so the run provisions no recorder and opens no microphone on
		// whatever machine it is on. What is asserted is that the host reached
		// it at all, which is the half the off arm proves it does not.
		const toggle = spyOn(controllerModule.STTController.prototype, "toggle").mockImplementation(async () => {});
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir: tempDir });
		const client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		const capabilities = (await client.nextFrame()) as {
			Snapshot: { Capabilities: [string, string | { Unavailable: { reason: string } }][] };
		};
		expect(new Map(capabilities.Snapshot.Capabilities).get("Dictation")).toBe("Available");

		const { frames, outcome } = await client.request(1, "ToggleDictation");
		expect(outcome).toEqual({ RequestSucceeded: { request: 1 } });
		expect(toggle).toHaveBeenCalledTimes(1);
		// The window is told what it is holding, or it draws an idle control
		// over an open microphone.
		expect(snapshotSections<DictationView>(frames, "Dictation").length).toBeGreaterThan(0);

		client.destroy();
	});
});
