/**
 * DS-6 dock: the composer footline shows a LIVE draft token estimate
 * (`~N tok`, gold matchHighlight) while a non-blank draft exists, and says
 * nothing otherwise — a quiet zone stays quiet. The number comes from the one
 * shared byte-aware estimator (estimateTokensFromText), so what the operator
 * sees matches the budget math the session runs on; a drifting local
 * `length / 4` copy was the exact ONE-PLACE violation this design forbids.
 *
 * Locks:
 *  1. Empty composer: no token zone anywhere in the frame.
 *  2. A typed draft surfaces `~N tok` with the estimator's exact number.
 *  3. Clearing the draft removes the zone again (live, not sticky).
 *  4. Whitespace-only drafts count as empty.
 *
 * The presence/absence checks match the exact zone marker `~<number> tok`, not
 * the bare substring " tok": a randomly-selected welcome tip can contain the
 * word "tokens" (e.g. "pulls live tokens over the wire"), and a " tok" substring
 * check there flaked the empty-composer case. The zone always carries a
 * `~<digits>` prefix, which no tip prose does.
 */
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
import { estimateTokensFromText, TempDir } from "@veyyon/utils";

describe("composer draft token count (DS-6 dock)", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let savedGeometry: Record<"columns" | "rows", PropertyDescriptor | undefined>;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
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
		tempDir = TempDir.createSync("@pi-composer-draft-tokens-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", () => {}, [], undefined, new EventBus());
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
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

	// The composer token zone: a `~<digits> tok` marker. Matching this (not a bare
	// " tok" substring) keeps the checks immune to tip prose containing "tokens".
	const TOKEN_ZONE = /~\d+ tok\b/;

	it("says nothing while the composer is empty", () => {
		expect(frame()).not.toMatch(TOKEN_ZONE);
	});

	it("shows the shared estimator's exact number for a typed draft", () => {
		const draft = "refactor the walker to stream entries instead of collecting them";
		mode.editor.setText(draft);
		expect(frame()).toContain(`~${estimateTokensFromText(draft)} tok`);
	});

	it("removes the zone when the draft is cleared (live, not sticky)", () => {
		mode.editor.setText("a real draft");
		expect(frame()).toMatch(TOKEN_ZONE);
		mode.editor.setText("");
		expect(frame()).not.toMatch(TOKEN_ZONE);
	});

	it("treats whitespace-only drafts as empty", () => {
		mode.editor.setText("   \n\t  ");
		expect(frame()).not.toMatch(TOKEN_ZONE);
	});

	/** Menu navigation is not a draft: a bare slash-command token stays
	 * counter-free (the live-capture noise this removes: "/" showed "~1 tok"),
	 * but the counter returns once the command carries argument text. */
	it("hides the counter for a bare slash-command token, shows it once args follow", () => {
		mode.editor.setText("/settings");
		expect(frame()).not.toMatch(TOKEN_ZONE);
		mode.editor.setText("/btw why does the walker collect entries eagerly");
		expect(frame()).toMatch(TOKEN_ZONE);
	});
});
