/**
 * WHY: a resumed session mounts the welcome hero, then renders its transcript
 * under it. A transcript taller than the screen pushes the card into native
 * scrollback before the operator types, and the first keystroke dismisses the
 * card. Dismissal used to unmount the card's root children. The rows they had
 * committed left the front of the frame with no report, the engine read the
 * shifted frame as diverged history, and it erased native scrollback and
 * replayed the whole transcript: every block of the session rendered again on
 * the first keystroke, which on a 600-turn session was the turn's memory peak.
 *
 * The hero now empties in place and reports the committed rows it dropped, so
 * the engine moves its commit record past rows the terminal already holds.
 *
 * THE INVARIANT, swept over transcript lengths that leave the card on screen,
 * across the viewport edge, and wholly in scrollback, on the production path
 * (a real InteractiveMode, the resume render `main.ts` runs, a keystroke into
 * the real editor): dismissal erases no scrollback, clears no viewport,
 * rewrites no row that sat above the viewport, and leaves every turn of the
 * session in the terminal exactly once.
 *
 * Against a hero that reports no dropped rows, the arms whose card sat in
 * scrollback (6 and 40 turns) fail with a scrollback erase. The arm across the
 * viewport edge (4 turns) passes against it: the home anchor fills the rows
 * the card left with blank rows, and the audit reads an all-blank comparison
 * as aligned.
 *
 * WHAT IT DOES NOT CATCH. A multiplexer pane, where the engine never erases
 * scrollback to repair a divergence; a resize between resume and dismissal;
 * and other roots above the transcript that shrink after committing, which
 * `every-dropping-root-leaves-the-commit-record-at-its-own-rows` in the engine
 * covers at the commit-record level.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme, setTheme, stopThemeWatcher } from "@veyyon/coding-agent/theme/theme";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { countDestructivePaints } from "../../../../../../hosts/terminal/engine/test/helpers/destructive-paints";
import { settleFrames } from "../../../../../../hosts/terminal/engine/test/helpers/settle-frames";
import { VirtualTerminal } from "../../../../../../hosts/terminal/engine/test/virtual-terminal";

const WIDTH = 100;
const HEIGHT = 30;
/** The letterspaced wordmark row of the hero card. */
const WORDMARK = "v e y y o n";
/** Transcript lengths: none, a few turns, enough to bury the card. */
const TURN_COUNTS = [0, 2, 4, 6, 40];

function question(turn: number): string {
	return `resumed question ${String(turn).padStart(3, "0")}`;
}

function answer(turn: number): string {
	return `resumed answer ${String(turn).padStart(3, "0")}`;
}

function assistantText(text: string, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		stopReason: "stop" as const,
		api: "anthropic" as const,
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	};
}

/** The terminal's buffer, styled bytes stripped, trailing blank rows dropped. */
function buffer(terminal: VirtualTerminal): string[] {
	const rows = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
	while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
	return rows;
}

function viewport(terminal: VirtualTerminal): string[] {
	return terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

function occurrences(rows: readonly string[], needle: string): number {
	return rows.filter(row => row.includes(needle)).length;
}

/** Where the card sat when the operator typed. */
type CardPlace = "on screen" | "across the viewport edge" | "in scrollback";

const places = new Map<number, CardPlace>();

describe("dismissing the hero over a resumed transcript replays nothing", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;

	beforeAll(async () => {
		await initTheme();
		await setTheme("dark");
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		mode = undefined;
		session = undefined;
		authStorage = undefined;
		tempDir = undefined;
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	afterAll(() => {
		stopThemeWatcher();
	});

	for (const turns of TURN_COUNTS) {
		it(`with ${turns} resumed turns`, async () => {
			resetSettingsForTest();
			tempDir = TempDir.createSync("@pi-hero-dismiss-resumed-");
			const dir = tempDir.path();
			await Settings.init({ inMemory: true, cwd: dir });
			authStorage = await AuthStorage.create(path.join(dir, "testauth.db"));
			const modelRegistry = new ModelRegistry(authStorage);
			const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
			session = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager: SessionManager.create(dir, dir),
				settings: Settings.isolated(),
				modelRegistry,
			});
			for (let turn = 0; turn < turns; turn++) {
				session.sessionManager.appendMessage({
					role: "user",
					content: [{ type: "text", text: question(turn) }],
					timestamp: turn * 2 + 1,
				});
				session.sessionManager.appendMessage(assistantText(answer(turn), turn * 2 + 2));
			}

			mode = new InteractiveMode(session, "test");
			const terminal = new VirtualTerminal(WIDTH, HEIGHT, 20_000);
			const paints = countDestructivePaints(terminal);
			let recording = false;
			const written: string[] = [];
			const write = terminal.write.bind(terminal);
			terminal.write = (data: string) => {
				if (recording) written.push(data);
				write(data);
			};
			mode.ui = new TUI(terminal);
			vi.spyOn(mode.statusLine, "watchGitState").mockImplementation(() => {});
			await mode.init();
			// The resume render `main.ts` runs once the mode is up.
			mode.renderInitialMessages({ preserveExistingChat: true, clearTerminalHistory: false });
			await settleFrames(terminal, mode.ui);

			const before = buffer(terminal);
			expect(occurrences(before, WORDMARK)).toBe(1);
			const viewportTop = before.length - HEIGHT;
			const aboveViewport = before.slice(0, Math.max(0, viewportTop));
			const place: CardPlace =
				occurrences(aboveViewport, WORDMARK) === 1
					? "in scrollback"
					: aboveViewport.some(row => row.length > 0)
						? "across the viewport edge"
						: "on screen";
			places.set(turns, place);
			const buried = Array.from({ length: turns }, (_, turn) => question(turn)).filter(
				marker => occurrences(aboveViewport, marker) > 0,
			);
			const erases = paints.erases();
			const clears = paints.clears();

			recording = true;
			mode.editor.handleInput("h");
			await settleFrames(terminal, mode.ui);
			recording = false;

			expect({ erases: paints.erases() - erases, clears: paints.clears() - clears }).toEqual({
				erases: 0,
				clears: 0,
			});
			const rewritten = Bun.stripANSI(written.join(""));
			expect(buried.filter(marker => rewritten.includes(marker))).toEqual([]);
			const after = buffer(terminal);
			for (let turn = 0; turn < turns; turn++) {
				expect({
					turn,
					questions: occurrences(after, question(turn)),
					answers: occurrences(after, answer(turn)),
				}).toEqual({ turn, questions: 1, answers: 1 });
			}
			expect(occurrences(viewport(terminal), WORDMARK)).toBe(0);
			// A card already in scrollback stays where it was, once.
			if (place === "in scrollback") expect(occurrences(after, WORDMARK)).toBe(1);
		}, 30_000);
	}

	// Fail by default: a sweep that misses one of the places the card can sit
	// when the operator types does not exercise every way the hero leaves.
	it("covers a card on screen, across the viewport edge, and in scrollback", () => {
		expect(new Set(places.values())).toEqual(
			new Set<CardPlace>(["on screen", "across the viewport edge", "in scrollback"]),
		);
	});
});
