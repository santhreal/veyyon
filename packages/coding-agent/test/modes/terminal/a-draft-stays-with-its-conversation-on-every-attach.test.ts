/**
 * WHY: the composer is one editor every conversation in the terminal shares.
 * A room switch carried the unsent draft away with the conversation that typed
 * it, but `/resume` of a running session and a `/new` hand-off attach another
 * conversation through `InteractiveMode.attachMainSession` directly, so the
 * draft stayed on the composer and the next room switch saved it under the
 * conversation that had arrived, leaving the one that typed it with nothing.
 *
 * The class: every path that puts another conversation on screen goes through
 * `attachMainSession`, so the draft moves there. Driven through a real
 * `InteractiveMode` and real sessions: the draft (text and an attached image)
 * leaves with the conversation that typed it, the arriving conversation gets
 * its own draft or a clear composer, and attaching back restores it whole.
 * Re-attaching the conversation already on screen leaves the composer alone.
 *
 * What it does NOT catch: a path that swaps sessions without
 * `attachMainSession` (an in-place `switchSession` keeps the same session
 * object, and its composer text stays with it), and saving drafts at exit,
 * which the room controller suite drives.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Api, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { BackgroundSessions } from "@veyyon/coding-agent/session/background-sessions";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

const IMAGE = {
	kind: "image" as const,
	name: "diagram.png",
	data: "aGVsbG8=",
	mimeType: "image/png",
	uri: "file:///repo/diagram.png",
};

describe("a draft stays with its conversation on every attach", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let model: Model<Api>;
	let originalHome: string | undefined;
	let mode: InteractiveMode | undefined;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-draft-attach-");
		originalHome = process.env.HOME;
		process.env.HOME = tempDir.path();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const resolved = registry.find("anthropic", "claude-sonnet-4-5");
		if (!resolved) throw new Error("Expected anthropic model claude-sonnet-4-5 to exist");
		model = resolved;
	});

	beforeEach(() => {
		vi.spyOn(os, "homedir").mockReturnValue(tempDir.path());
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		mode = undefined;
		for (const session of sessions.splice(0)) {
			BackgroundSessions.global().release(session);
			await session.dispose();
		}
	});

	afterAll(() => {
		authStorage?.close();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function conversation(): AgentSession {
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: registry,
			toolRegistry: new Map(),
			promptTemplates: [],
		});
		sessions.push(session);
		return session;
	}

	function composer(target: InteractiveMode): { text: string; attachments: readonly unknown[] } {
		return { text: target.editor.getText(), attachments: target.editor.attachments };
	}

	it("leaves with the conversation that typed it, and comes back whole when it is attached again", () => {
		const a = conversation();
		const b = conversation();
		mode = new InteractiveMode(a, "test");
		mode.editor.setText("fix the parser");
		mode.editor.attachments = [IMAGE];

		// What `/resume` of a running session and a `/new` hand-off both do.
		mode.attachMainSession(b);
		expect(composer(mode)).toEqual({ text: "", attachments: [] });

		mode.editor.setText("a question for b");
		// `/resume` takes the kept session out of the background before attaching it.
		BackgroundSessions.global().release(a);
		mode.attachMainSession(a);
		expect(composer(mode)).toEqual({ text: "fix the parser", attachments: [IMAGE] });

		BackgroundSessions.global().release(b);
		mode.attachMainSession(b);
		expect(composer(mode)).toEqual({ text: "a question for b", attachments: [] });
	});

	it("leaves the composer alone when the conversation on screen is attached again", () => {
		const a = conversation();
		mode = new InteractiveMode(a, "test");
		mode.editor.setText("still typing");
		mode.attachMainSession(a);
		expect(composer(mode)).toEqual({ text: "still typing", attachments: [] });
	});
});
