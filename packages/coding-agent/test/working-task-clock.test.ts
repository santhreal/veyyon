/**
 * Per-task elapsed clock on the working line — the loader row reads
 * `▓ Running final installer proof · 0:42 ⟦esc⟧`. The clock measures how long
 * the CURRENT task label has been showing (each tool call sets a new label),
 * so the operator can see at a glance whether a step is 2 seconds or 4
 * minutes old. Before this feature the working line carried no timing at all,
 * which is the exact gap the user reported from a live keyhog run.
 *
 * Locks:
 *  1. The clock appears immediately (`0:00`) for the default Working… phase.
 *  2. It sits BETWEEN the task label and the esc hint, in that order.
 *  3. Re-applying the same label refreshes the clock without resetting it
 *     (the 1s heartbeat rides this path — a reset here would pin it at 0:00).
 *  4. A NEW label restarts the clock at 0:00 (per-task, not per-run).
 *  5. Clearing the loader forgets the clock; the next run starts fresh.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { interruptHint } from "@veyyon/coding-agent/modes/shared";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { TempDir } from "@veyyon/utils";

describe("working line per-task elapsed clock", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let savedGeometry: Record<"columns" | "rows", PropertyDescriptor | undefined>;
	const T0 = new Date("2026-07-22T10:00:00Z");

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		setSystemTime(T0);
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
		tempDir = TempDir.createSync("@pi-working-task-clock-");
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
		setSystemTime();
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

	function advance(ms: number): void {
		setSystemTime(new Date(T0.getTime() + ms));
	}

	const hint = () => stripVTControlCharacters(interruptHint());

	it("shows 0:00 for the default Working… phase the moment the loader appears", () => {
		mode.ensureLoadingAnimation();
		expect(frame()).toContain(`Working… · 0:00${hint()}`);
	});

	it("places the clock between a task label and the esc hint", () => {
		mode.ensureLoadingAnimation();
		mode.setWorkingMessage(`Running final installer proof${interruptHint()}`);
		expect(frame()).toContain(`Running final installer proof · 0:00${hint()}`);
	});

	it("advances with wall time when the same label is re-applied (heartbeat path)", () => {
		mode.ensureLoadingAnimation();
		const message = `Running final installer proof${interruptHint()}`;
		mode.setWorkingMessage(message);
		advance(95_000);
		mode.setWorkingMessage(message);
		expect(frame()).toContain(`Running final installer proof · 1:35${hint()}`);
	});

	it("restarts at 0:00 when the task label changes", () => {
		mode.ensureLoadingAnimation();
		mode.setWorkingMessage(`Running final installer proof${interruptHint()}`);
		advance(95_000);
		mode.setWorkingMessage(`Verifying checksums${interruptHint()}`);
		// Scope to the loader row: the location line's TOTAL clock legitimately
		// reads 1:35 at this instant, and must not mask a task-clock leak.
		const loaderRow = frame()
			.split("\n")
			.find(line => line.includes("Verifying checksums"));
		expect(loaderRow).toContain(`Verifying checksums · 0:00${hint()}`);
		expect(loaderRow).not.toContain("1:35");
	});

	it("forgets the clock when the loader clears, so the next run starts fresh", () => {
		mode.ensureLoadingAnimation();
		mode.setWorkingMessage(`Running final installer proof${interruptHint()}`);
		advance(95_000);
		mode.clearWorkingLoader();
		advance(180_000);
		mode.ensureLoadingAnimation();
		expect(frame()).toContain(`Working… · 0:00${hint()}`);
	});
});
