/**
 * The interactive clock heartbeat repaints the working line's per-task clock once a second while
 * the agent works, and holds no timer while the session rests.
 *
 * Defect closed: the heartbeat was a `setInterval` armed once at init and never cleared, so a
 * session waiting on its user woke every second to run a tick that returned at once. On Bun each
 * of those wakeups also kept the engine's GC timer collecting over the idle heap.
 *
 * Class: any timer an interactive session leaves armed while it rests. The resting assertions
 * count every pending timer after ten minutes at rest, past every one-shot timeout init arms, so
 * a repeating or self-rearming timer added anywhere on the mode's init path turns this suite red.
 *
 * Gap: the loop watchdog the terminal engine starts ticks at rest by design and is held off here;
 * `an-idle-process-samples-its-stack-ten-times-less-often.test.ts` and the watchdog suites cover
 * it. The idle trim and the stall sampler are started by the CLI entry and are not constructed
 * here.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { interruptHint } from "@veyyon/coding-agent/modes/terminal/shared";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { LoopWatchdog } from "@veyyon/utils/loop-watchdog";

describe("the working clock ticks only while the agent works", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let savedGeometry: Record<"columns" | "rows", PropertyDescriptor | undefined>;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.useFakeTimers({ now: new Date("2026-07-22T10:00:00Z") });
		vi.spyOn(LoopWatchdog.prototype, "start").mockImplementation(() => {});
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
		tempDir = TempDir.createSync("@pi-working-clock-rest-");
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
		vi.spyOn(mode.statusLine, "watchGitState").mockImplementation(() => {});
		await mode.init();
	});

	afterEach(async () => {
		mode?.stop();
		vi.useRealTimers();
		for (const key of ["columns", "rows"] as const) {
			const descriptor = savedGeometry[key];
			if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
			else delete (process.stdout as unknown as Record<string, unknown>)[key];
		}
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	const label = "Running final installer proof";

	function loaderRow(): string | undefined {
		return mode.ui
			.render(100)
			.map(line => stripVTControlCharacters(line))
			.find(line => line.includes(label));
	}

	function startWorking(): void {
		mode.ensureLoadingAnimation();
		mode.setWorkingMessage(`${label}${interruptHint()}`);
	}

	it("repaints the task clock each second with no agent event", () => {
		startWorking();
		vi.advanceTimersByTime(2_000);
		expect(loaderRow()).toContain(`${label} · 0:02`);
	});

	it("holds no timer once a freshly started session has rested", () => {
		vi.advanceTimersByTime(600_000);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("holds no timer once the agent stops working and the session has rested", () => {
		startWorking();
		vi.advanceTimersByTime(3_000);
		mode.clearWorkingLoader();
		vi.advanceTimersByTime(600_000);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("ticks again when the next run mounts the working loader after a rest", () => {
		vi.advanceTimersByTime(60_000);
		startWorking();
		vi.advanceTimersByTime(3_000);
		expect(loaderRow()).toContain(`${label} · 0:03`);
	});
});
