/**
 * Profile-switch handoff: `/profile <name>` relaunches the process under a new
 * profile, and the handoff from the dying session to the relaunched child must
 * be atomic. The observed failure: a `/profile` switch closes the session and runs a
 * series of commands, and the old session is sometimes reattached before those
 * commands finish.
 *
 * WHAT THE RACE WAS. `InteractiveMode.shutdown()` showed "Closing session…" and
 * then awaited the session teardown, a promise-memoized singleton whose
 * memory-consolidate budget (SHUTDOWN_CONSOLIDATE_BUDGET_MS) can stretch to
 * SECONDS, plus a fixed `drainInput(1000)`. For that whole window the TUI was
 * still fully alive: the render loop kept painting the OLD session and every
 * keystroke still landed in the OLD session's editor (Enter even submitted into
 * the disposing session). A slow consolidate made the window wide, which is the
 * operator's "sometimes": they watched the closing messages scroll by, typed,
 * and found themselves back in the session they had just left.
 *
 * These tests drive the REAL path: a booted InteractiveMode on a
 * VirtualTerminal, the real `executeBuiltinSlashCommand("/profile …")`
 * dispatch, the real registry port, the real `shutdown()`, with only the
 * process boundary stubbed (`Bun.spawn`, `postmortem.quit`) and teardown
 * slowness injected deterministically at `session.dispose`.
 *
 * RED PROOF: reverting the shutdown-region fix makes the first two tests fail
 * exactly as the operator described (keystrokes land in the dying session,
 * frames keep painting after shutdown begins); reverting the
 * profile-command env fix fails the third.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { createProfile } from "@veyyon/coding-agent/cli/profile-cli";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { initTheme, setTheme, stopThemeWatcher } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { executeBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import { TUI } from "@veyyon/tui";
import { postmortem, setProfile, TempDir } from "@veyyon/utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";

interface SpawnRecord {
	argv: string[];
	env: Record<string, string | undefined> | undefined;
	/** The relaunch spawn is the one shutdown() makes with a fully inherited terminal. */
	inheritStdio: boolean;
	/** Position in the event timeline, so the test can assert spawn happens after the UI stops. */
	seq: number;
}

interface HandoffHarness {
	mode: InteractiveMode;
	session: AgentSession;
	terminal: VirtualTerminal;
	/** Every byte the TUI wrote to the terminal, in order. */
	writes: string[];
	spawnCalls: SpawnRecord[];
	quitCodes: Array<number | undefined>;
	/** Errors escaped from the (production-fire-and-forget) slash dispatch. */
	dispatchErrors: unknown[];
	/** Set once `session.dispose` is entered (teardown in flight). */
	disposeEntered: Promise<void>;
	/** Releases the injected teardown slowness. */
	releaseDispose: () => void;
	/** Resolves when the stubbed child exits. */
	finishChild: (code: number) => void;
	uiStopSeq: () => number;
	/** Resolves with the exit code once the handoff reaches `postmortem.quit`. */
	quitCalled: Promise<number | undefined>;
	/** Drive the real `/profile` dispatch and record any escaped rejection. */
	dispatch: (text: string) => void;
	/**
	 * Unblock a still-open teardown/child and await the handoff. afterEach MUST
	 * await this before restoring mocks: a shutdown left dangling would reach
	 * the real `Bun.spawn` after the stub comes off, and `resolveVeyyonCommand`
	 * under `bun test` names the test file itself as the entry, spawning it as
	 * a plain script, which re-evaluates this module outside the runner.
	 */
	forceSettle: () => Promise<void>;
}

describe("profile switch handoff (atomic teardown + relaunch)", () => {
	let isolated: IsolatedConfigRoot | undefined;
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;
	let lastHarness: HandoffHarness | undefined;

	beforeEach(async () => {
		// Profiles live under the config root, so the root must be isolated
		// before createProfile / resolveProfileByName run. `defaultProfile:
		// true` also strips any inherited VEYYON_PROFILE from this process.
		isolated = enterIsolatedConfigRoot("profile-switch-handoff", { defaultProfile: true });
	});

	async function boot(options: { slowTeardown: boolean }): Promise<HandoffHarness> {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-profile-switch-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });
		await initTheme();
		await setTheme("dark");

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		const createdSession = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		session = createdSession;

		const createdMode = new InteractiveMode(createdSession, "test");
		mode = createdMode;
		const terminal = new VirtualTerminal(100, 20);
		createdMode.ui = new TUI(terminal);

		const writes: string[] = [];
		const realWrite = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		vi.spyOn(createdMode.statusLine, "watchBranch").mockImplementation(() => {});

		// Event timeline: a monotonic sequence stamped on spawn and ui.stop so
		// the test can assert the child is spawned only after the terminal is
		// released.
		let seq = 0;
		const nextSeq = () => ++seq;
		let stopSeq = 0;
		const realUiStop = createdMode.ui.stop.bind(createdMode.ui);
		vi.spyOn(createdMode.ui, "stop").mockImplementation(() => {
			if (stopSeq === 0) stopSeq = nextSeq();
			realUiStop();
		});

		// Process boundary stubs: the relaunch child and the final exit.
		const spawnCalls: SpawnRecord[] = [];
		const quitCodes: Array<number | undefined> = [];
		let quitResolve: (code: number | undefined) => void = () => {};
		const quitCalled = new Promise<number | undefined>(resolve => {
			quitResolve = resolve;
		});
		let finishChild: (code: number) => void = () => {};
		const childExited = new Promise<number>(resolve => {
			finishChild = resolve;
		});
		vi.spyOn(Bun, "spawn").mockImplementation(((
			argv: string[],
			opts?: { env?: Record<string, string>; stdio?: unknown },
		) => {
			const stdio = (opts as { stdio?: unknown[] } | undefined)?.stdio;
			const inheritStdio = Array.isArray(stdio) && stdio.length === 3 && stdio.every(s => s === "inherit");
			spawnCalls.push({ argv: [...argv], env: opts?.env, inheritStdio, seq: nextSeq() });
			return { exited: childExited, kill: () => {}, killed: false };
		}) as unknown as typeof Bun.spawn);
		vi.spyOn(postmortem, "quit").mockImplementation(async (code?: number) => {
			quitCodes.push(code);
			quitResolve(code);
		});

		// Deterministic teardown slowness: the production consolidate budget can
		// hold this window for seconds; the test holds it until releaseDispose().
		let releaseDispose: () => void = () => {};
		const disposeGate = new Promise<void>(resolve => {
			releaseDispose = resolve;
		});
		let disposeEnteredResolve: () => void = () => {};
		const disposeEntered = new Promise<void>(resolve => {
			disposeEnteredResolve = resolve;
		});
		let teardownEntered = false;
		void disposeEntered.then(() => {
			teardownEntered = true;
		});
		let quitSettled = false;
		void quitCalled.then(() => {
			quitSettled = true;
		});
		const dispatchErrors: unknown[] = [];
		const realDispose = createdSession.dispose.bind(createdSession);
		vi.spyOn(createdSession, "dispose").mockImplementation(async (disposeOptions?: unknown) => {
			disposeEnteredResolve();
			if (options.slowTeardown) await disposeGate;
			return realDispose(disposeOptions as never);
		});

		await createdMode.init({ suppressWelcomeIntro: true });
		await terminal.waitForRender();

		const harness: HandoffHarness = {
			mode: createdMode,
			session: createdSession,
			terminal,
			writes,
			spawnCalls,
			quitCodes,
			dispatchErrors,
			disposeEntered,
			releaseDispose,
			finishChild,
			uiStopSeq: () => stopSeq,
			quitCalled,
			dispatch: text => {
				void executeBuiltinSlashCommand(text, { ctx: createdMode }).catch(error => {
					dispatchErrors.push(error);
				});
			},
			forceSettle: async () => {
				releaseDispose();
				finishChild(0);
				// Only an in-flight handoff has a quit to wait for; awaiting
				// quitCalled unconditionally would hang a test that failed before
				// ever dispatching.
				if (teardownEntered && !quitSettled) await quitCalled;
			},
		};
		lastHarness = harness;
		return harness;
	}

	afterEach(async () => {
		// A failing test can leave the injected teardown gate or the stubbed
		// child unresolved; settle the handoff BEFORE the spies come off so a
		// dangling shutdown never reaches the real Bun.spawn (see forceSettle).
		await lastHarness?.forceSettle();
		lastHarness = undefined;
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		mode = undefined;
		session = undefined;
		authStorage = undefined;
		tempDir = undefined;
		vi.restoreAllMocks();
		isolated?.restore();
		isolated = undefined;
		resetSettingsForTest();
		stopThemeWatcher();
		await setTheme("dark");
	});

	it("accepts no keystroke and paints no old-session frame once shutdown begins", async () => {
		const h = await boot({ slowTeardown: true });
		await createProfile("other", "blank");

		// A live working animation is the operator's real scenario: switching
		// profile mid-turn. The Loader ticks requestRender at spinner cadence,
		// so if shutdown leaves frame producers connected, the dying session
		// keeps painting through the whole teardown window.
		h.mode.ensureLoadingAnimation();
		await h.terminal.waitForRender();

		// The real dispatch: /profile other -> registry port -> requestRelaunch
		// + requestShutdown -> InteractiveMode.shutdown().
		h.dispatch("/profile other");
		await h.disposeEntered;
		// Let the "Switching to profile…" / "Closing session…" paints settle so
		// every write observed below happens strictly inside the teardown window.
		await h.terminal.waitForRender();

		const writesBeforeInput = h.writes.length;
		h.terminal.sendInput("h");
		h.terminal.sendInput("i");
		await h.terminal.waitForRender();
		// Wait out two full spinner cadences (~80ms each at 12.5fps) so a loader
		// left running by a missing frame freeze has definitely ticked. Real
		// wall-clock wait, deliberately: the Loader owns a real setInterval that
		// fake timers cannot reach through this harness's real async dispose
		// chain, and the assertion below is symmetric: with the freeze in place
		// NOTHING can write no matter how long the wait.
		await Bun.sleep(250);

		// The dying session must not accept the keystrokes…
		expect(h.mode.editor.getText()).toBe("");
		// …and must not paint another frame, not for the keystrokes, not for
		// the working animation.
		expect(h.writes.length).toBe(writesBeforeInput);

		// Release the teardown, let the handoff complete.
		h.releaseDispose();
		h.finishChild(0);
		expect(await h.quitCalled).toBe(0);

		// The child carries the new profile and is spawned only after the old
		// session released the terminal. (Incidental spawns like the status
		// line's `git status` are filtered out by the inherited-stdio signature
		// of the relaunch spawn.)
		const relaunch = h.spawnCalls.filter(c => c.inheritStdio);
		expect(relaunch).toHaveLength(1);
		expect(relaunch[0]!.env?.VEYYON_PROFILE).toBe("other");
		expect(h.uiStopSeq()).toBeGreaterThan(0);
		expect(relaunch[0]!.seq).toBeGreaterThan(h.uiStopSeq());
		expect(h.quitCodes[0]).toBe(0);
	});

	it("keeps the handoff atomic even when teardown is fast", async () => {
		const h = await boot({ slowTeardown: false });
		await createProfile("other", "blank");

		h.dispatch("/profile other");
		// Teardown has begun (dispose was entered), so the shutdown input gate,
		// installed synchronously at the top of shutdown() before teardown,
		// is deterministically in force wherever the fast dispose has got to.
		await h.disposeEntered;
		h.terminal.sendInput("x");
		await h.terminal.waitForRender();
		h.finishChild(0);
		await h.quitCalled;

		expect(h.dispatchErrors).toEqual([]);
		expect(h.mode.editor.getText()).toBe("");
		const relaunch = h.spawnCalls.filter(c => c.inheritStdio);
		expect(relaunch).toHaveLength(1);
		expect(relaunch[0]!.env?.VEYYON_PROFILE).toBe("other");
		expect(relaunch[0]!.seq).toBeGreaterThan(h.uiStopSeq());
	});

	it("pins VEYYON_PROFILE into the child env when switching to the default profile", async () => {
		// Switching from a named profile to "default" resolves to `undefined`.
		// The spawn merge in shutdown() drops undefined values, so without an
		// explicit override the child would boot with NO VEYYON_PROFILE at all
		// and fall back to the global `defaultProfile` setting, which can name
		// the very profile the operator just left. That is a permanent "slips
		// back into the other session", not a transient one. The empty string is
		// the documented override: an explicitly-empty VEYYON_PROFILE forces the
		// default profile past the global defaultProfile setting (dirs.ts,
		// profileEnvIsSet / normalizeProfileName).
		const h = await boot({ slowTeardown: false });
		// The slip-back only exists from a NAMED profile: from the default
		// profile the switch is a guarded no-op ("Already on profile"). Put the
		// parent on "work" so VEYYON_PROFILE=work is what the child env merge
		// has to override.
		await createProfile("work", "blank");
		setProfile("work");
		expect(process.env.VEYYON_PROFILE).toBe("work");

		h.dispatch("/profile default");
		h.finishChild(0);
		await h.quitCalled;
		expect(h.dispatchErrors).toEqual([]);

		const relaunch = h.spawnCalls.filter(c => c.inheritStdio);
		expect(relaunch).toHaveLength(1);
		const env = relaunch[0]!.env ?? {};
		expect(Object.hasOwn(env, "VEYYON_PROFILE")).toBe(true);
		expect(env.VEYYON_PROFILE).toBe("");
	});
});
