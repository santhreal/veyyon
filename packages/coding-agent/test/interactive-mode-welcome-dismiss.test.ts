import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { TempDir } from "@veyyon/utils";

describe("InteractiveMode welcome dismissal (UI-10)", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let savedGeometry: Record<"columns" | "rows", PropertyDescriptor | undefined>;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		// Prevent ProcessTerminal.start() from touching the real terminal; the
		// test only reads rendered output via mode.ui.render().
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		// Pin the terminal geometry the fill math reads (bun:test's spyOn lacks
		// the getter overload, so defineProperty + descriptor restore in afterEach).
		savedGeometry = {
			columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
			rows: Object.getOwnPropertyDescriptor(process.stdout, "rows"),
		};
		Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-interactive-mode-welcome-dismiss-");
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
		mode = new InteractiveMode(session, "test", () => {}, [], undefined, new EventBus());
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	});

	afterEach(async () => {
		for (const key of ["columns", "rows"] as const) {
			const descriptor = savedGeometry[key];
			if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
			else delete (process.stdout as unknown as Record<string, unknown>)[key];
		}
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function frame(): string {
		return mode.ui
			.render(100)
			.map(line => stripVTControlCharacters(line))
			.join("\n");
	}

	it("centres the sunrise vertically (UI-2): real top margin above the sun", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const lines = frame().split("\n");
		const sunTop = lines.findIndex(line => /[░▒▓]/.test(line));
		// 40 mocked terminal rows leave generous slack around the sunrise header;
		// 2/5 of it sits above the sun, so the hero cannot hug the top edge.
		expect(sunTop).toBeGreaterThanOrEqual(4);
	});

	/** Live-capture regression (2026-07-22, 120x34 tmux): /welcome on the home
	 * screen left the home hero mounted AND kept the empty-home slack, so the
	 * freshly added full card was pushed clean off the top — the user saw a
	 * blank screen with two suns in scrollback. showFullWelcome must dismiss
	 * the home hero and remeasure the anchor on the same frame. */
	it("/welcome replaces the home hero and renders the full card inside the viewport", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.showFullWelcome();
		const lines = frame().split("\n");
		expect(lines.length).toBeLessThanOrEqual(40);
		const joined = lines.join("\n");
		// The menu card is on screen…
		expect(joined).toContain("Resume session");
		expect(joined).toContain("/settings");
		// …and exactly ONE hero: a second wordmark means the home hero survived.
		const wordmarks = lines.filter(line => line.includes("v e y y o n"));
		expect(wordmarks).toHaveLength(1);
	});

	it("first message renders at the top with the composer still locked to the viewport bottom", async () => {
		await mode.init({ suppressWelcomeIntro: true });

		// Home screen: the composer is pinned to the viewport bottom by a large
		// reserved bottom-fill, so the frame spans (about) the whole 40-row terminal.
		const homeLines = frame().split("\n");
		expect(homeLines.length).toBeGreaterThan(30);

		// Type to dismiss the hero, then submit the first message — the exact path a
		// user takes. The message text must be a recognizable marker.
		mode.editor.handleInput("h");
		const marker = "first-message-visibility-marker";
		mode.startPendingSubmission({ text: marker });

		const afterLines = frame().split("\n");
		const rendered = afterLines.join("\n");

		// The message is present and inside the viewport, never scrolled off the top
		// by leftover reserved slack (the old "cut off" / downward-jerk symptom).
		expect(rendered).toContain(marker);
		expect(afterLines.length).toBeLessThanOrEqual(40);

		// A short first message must NOT drag the composer up under it. Streaming
		// starts at the top of scrollback and the composer stays locked to the
		// bottom edge, with the reserved fill between them — this is the whole point
		// of the anchor, and collapsing it on submit (the prior over-correction) is
		// exactly the "prompt box stuck upwards" regression this guards against.
		const markerRow = afterLines.findIndex(line => line.includes(marker));
		expect(markerRow).toBeGreaterThanOrEqual(0);
		// The user message sits in the top region of the viewport.
		expect(markerRow).toBeLessThan(8);
		// The composer placeholder sits in the bottom region of the 40-row viewport.
		const composerRow = afterLines.findIndex(line => line.includes("ask anything"));
		expect(composerRow).toBeGreaterThanOrEqual(30);
		// Concretely: the composer is far below the message, so a real fill gap
		// separates them (the composer is anchored to the bottom, not riding up).
		expect(composerRow - markerRow).toBeGreaterThan(20);
	});

	it("latches the anchor off once the transcript fills the viewport: no reserved gap, composer on the natural bottom", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		mode.editor.handleInput("h");

		// Submit a message tall enough to overflow the 40-row viewport on its own.
		// Once real content fills the screen there is no slack to reserve, so the
		// anchor must collapse to zero fill and let output scroll naturally — not
		// keep a gap wedged between the content and the composer.
		const tall = Array.from({ length: 60 }, (_, i) => `overflow-line-${i}`).join("\n");
		mode.startPendingSubmission({ text: tall });

		const afterLines = frame().split("\n");

		// The composer placeholder is the last content in the frame (natural bottom),
		// with no large reserved blank run above it — the fill has collapsed to zero.
		const composerRow = afterLines.findIndex(line => line.includes("ask anything"));
		expect(composerRow).toBeGreaterThanOrEqual(0);
		let maxBlankRun = 0;
		let run = 0;
		for (const line of afterLines.slice(0, composerRow)) {
			run = line.trim().length === 0 ? run + 1 : 0;
			if (run > maxBlankRun) maxBlankRun = run;
		}
		expect(maxBlankRun).toBeLessThan(4);

		// Latched for good: a later short turn must not re-inflate the fill and
		// bounce the composer back up (output has scrolled into native scrollback,
		// where the live frame is short again).
		mode.startPendingSubmission({ text: "tiny follow up" });
		const followLines = frame().split("\n");
		const followComposerRow = followLines.findIndex(line => line.includes("ask anything"));
		let followMaxBlank = 0;
		run = 0;
		for (const line of followLines.slice(0, followComposerRow)) {
			run = line.trim().length === 0 ? run + 1 : 0;
			if (run > followMaxBlank) followMaxBlank = run;
		}
		expect(followMaxBlank).toBeLessThan(4);
	});

	it("clears the sunrise on the first real keystroke and keeps it gone", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		// The wordmark is letterspaced text in the terminal's own font.
		expect(frame()).toContain("v e y y o n");

		mode.editor.handleInput("h");
		expect(frame()).not.toContain("v e y y o n");

		// Emptying the draft does not resurrect the sunrise; dismissal is one-way.
		mode.editor.setText("");
		expect(frame()).not.toContain("v e y y o n");

		// Idempotent: a second dismissal on an already-clean screen is a no-op.
		mode.dismissWelcome();
		expect(frame()).not.toContain("v e y y o n");
	});
});
