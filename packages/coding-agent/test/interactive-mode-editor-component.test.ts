/**
 * WHY: `InteractiveMode.setEditorComponent` is the seam an extension uses to
 * replace the composer, so the defect class is a host editor the mode accepts
 * and then cannot drive. Two halves: the interface in
 * `hosts/terminal/engine/src/components/editor-component.ts`, which is type-only and
 * therefore leaves nothing behind for a runtime assertion to check, and the
 * mode's own handling of a swapped-in editor, which is what the cases below
 * drive. The type lock under `TestModalEditor` covers the first half.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { CustomEditor } from "@veyyon/coding-agent/modes/terminal/components/composer/custom-editor";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TUI } from "@veyyon/tui";
import type { EditorComponent } from "@veyyon/tui/components/editor-component";
import { TempDir } from "@veyyon/utils";
import type { UIEvent } from "@veyyon/wire/presentation";
import { settleFrames } from "../../../hosts/terminal/engine/test/helpers/settle-frames";
import { VirtualTerminal } from "../../../hosts/terminal/engine/test/virtual-terminal";

class TestModalEditor extends CustomEditor {}

/**
 * The editor a host swaps in is checked by the compiler and by nothing else:
 * `EditorComponent` is an interface, so a required member dropped from
 * `CustomEditor` breaks every extension that subclasses it and leaves no runtime
 * trace for an assertion to find. This binding fails `check:ts` instead, naming
 * the class that stopped satisfying the contract.
 */
type UnsatisfiedEditorContract = TestModalEditor extends EditorComponent
	? never
	: "CustomEditor no longer satisfies EditorComponent";
const _custom_editor_satisfies_the_editor_contract: UnsatisfiedEditorContract extends never
	? true
	: UnsatisfiedEditorContract = true;
void _custom_editor_satisfies_the_editor_contract;

describe("InteractiveMode.setEditorComponent", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-editor-component-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("replaces the editor and rebinds interactive handlers", () => {
		mode.editor.setText("draft prompt");
		const previousEditor = mode.editor;
		const refreshSpy = vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();

		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));

		expect(mode.editor).toBeInstanceOf(TestModalEditor);
		expect(mode.editor).not.toBe(previousEditor);
		expect(mode.editor.getText()).toBe("draft prompt");
		expect(mode.editor.onSubmit).toBeDefined();
		expect(mode.editor.onEscape).toBeDefined();
		expect(refreshSpy).toHaveBeenCalled();
	});

	it("the production presentation context updates the adopted engine and replacement editor", async () => {
		const terminal = new VirtualTerminal(100, 30);
		mode.ui = new TUI(terminal);
		mode.ui.addChild(mode.chatContainer);
		mode.ui.addChild(mode.editorContainer);
		mode.ui.addChild(mode.capabilityLine);
		mode.ui.setFocus(mode.editor);
		mode.statusLine.updateSettings({
			preset: "custom",
			leftSegments: ["model"],
			rightSegments: ["session_name"],
		});
		const events: UIEvent[] = [];
		const unsubscribe = mode.presentation.onInput(event => events.push(event));
		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		mode.ui.start();
		mode.presentation.start();
		try {
			mode.presentation.appendTranscriptBlock({
				kind: "user-message",
				id: "adopted-message",
				text: "ADOPTED_TRANSCRIPT",
				attachments: [],
				timestamp: 1000,
			});
			const status = mode.statusProducer.getSnapshot();
			mode.presentation.setStatusLine({
				...status,
				facts: { ...status.facts, sessionName: "ADOPTED_SESSION" },
			});
			await settleFrames(terminal, mode.ui);
			expect(terminal.getViewport().join("\n")).toContain("ADOPTED_TRANSCRIPT");
			expect(terminal.getViewport().join("\n")).toContain("ADOPTED_SESSION");

			mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
			terminal.sendInput("replacement draft");
			await settleFrames(terminal, mode.ui);
			expect(mode.editor.getText()).toBe("replacement draft");
			expect(terminal.getViewport().join("\n")).toContain("replacement draft");
			expect(events).toContainEqual({
				type: "composer-change",
				text: "replacement draft",
				cursorOffset: 17,
			});
		} finally {
			unsubscribe();
			mode.presentation.stop();
			mode.ui.stop();
		}
	});
});
