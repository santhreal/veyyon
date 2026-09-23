import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { CustomMessageEntry } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { getProjectDir, setProjectDir, TempDir } from "@veyyon/utils";

/**
 * A conversation that is not on screen never re-scopes the one that is.
 *
 * WHY THIS SUITE EXISTS. A room runs several top-level conversations in one
 * process and shows one of them. Every top-level `AgentSession` re-scoped the
 * process on a cwd change: it reloaded the shared Settings instance for its new
 * directory, chdir'd the process, and reset provider globals, plugin roots and
 * capabilities. So an off-screen conversation running `set_cwd` moved the
 * conversation on screen into a project nobody chose for it. The second defect
 * was the per-session repeat guard: after B moved the process to its directory,
 * bringing A back and re-scoping to A's directory was skipped as a repeat of A's
 * own last re-scope, and the process stayed in B's project.
 *
 * THE CLASS CLOSED. A top-level session in the background writes no process
 * scope and refreshes no runtime of its own through any cwd entry point
 * (`setCwd`, `moveToCwd`, `rescopeToCwd`, `switchSession`), and still records
 * the move on its own SessionManager. The claim that brings it back re-scopes
 * whenever the process is elsewhere or a move was deferred, whatever that
 * session's own guard remembers, and does nothing otherwise. A claim that fails
 * leaves the session in the background, and the next claim redoes it in full. A
 * spawned session and a lone foreground session behave as they did before.
 *
 * Observed through real boundaries only: `getProjectDir()` and `process.cwd()`
 * together, the shared Settings scope, the session's transcript and events, and
 * the seams a host supplies (the prompt builder and the secret loader), which
 * record the directory each refresh ran for. Nothing on the session is mocked.
 *
 * NOT CAUGHT. The entry points are listed by hand, because no registry names the
 * methods that reach the private re-scope; a new one that bypasses it is not
 * seen. Claims on two different sessions are not serialized against each other,
 * and a release issued while a claim is in flight is overridden when that claim
 * succeeds; both orderings belong to the caller. Paths that rebuild a background
 * session's prompt without a cwd change (`refreshSecrets`, tool changes) are out
 * of scope. Provider globals, plugin roots and capabilities are not asserted one
 * by one; they are written in the same block as the project dir that is. The ssh
 * tool refresh is not observed, because no `reloadSshTool` seam is supplied.
 */

interface Conversation {
	session: AgentSession;
	/** Each runtime refresh the host seams ran, as `secrets:<dir>` or `prompt:<dir>`. */
	refreshes: string[];
	/** Each `cwd_changed` event, as `<previous> -> <cwd>`. */
	moves: string[];
	/** Make the next prompt build throw, as a broken project configuration would. */
	failNextPromptBuild(): void;
}

describe("an off-screen conversation never re-scopes the one on screen", () => {
	let tempDir: TempDir;
	let originalProjectDir: string;
	let model: Model;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		// A foreground re-scope really chdirs the process, so it is put back before
		// the temp directory it may be sitting in is deleted.
		originalProjectDir = getProjectDir();
		tempDir = TempDir.createSync("@pi-room-foreground-");
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected the bundled anthropic model to exist");
		model = bundled;
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage.close();
		setProjectDir(originalProjectDir);
		tempDir.removeSync();
	});

	/** A real directory, because `setCwd` validates that the destination exists. */
	function makeDir(name: string): string {
		const dir = path.join(tempDir.path(), name);
		fs.mkdirSync(dir, { recursive: true });
		return fs.realpathSync(dir);
	}

	/** The process scope, read from both of its halves and the shared Settings instance. */
	function processScope(settings: Settings): { projectDir: string; processCwd: string; settings: string } {
		return { projectDir: getProjectDir(), processCwd: fs.realpathSync(process.cwd()), settings: settings.getCwd() };
	}

	function scopedTo(dir: string): { projectDir: string; processCwd: string; settings: string } {
		return { projectDir: dir, processCwd: dir, settings: dir };
	}

	function cwdChangedNotes(session: AgentSession): string[] {
		return session.sessionManager
			.getEntries()
			.filter(
				(entry): entry is CustomMessageEntry =>
					entry.type === "custom_message" && entry.customType === "cwd_changed",
			)
			.map(entry => String(entry.content));
	}

	/** A transcript recorded at `cwd`, for a switch to adopt. */
	async function recordTranscriptAt(cwd: string): Promise<string> {
		const manager = SessionManager.create(cwd, path.join(tempDir.path(), `sessions-${path.basename(cwd)}`));
		manager.appendMessage({ role: "user", content: "earlier work", timestamp: 1 });
		await manager.ensureOnDisk();
		await manager.flush();
		const file = manager.getSessionFile();
		await manager.close();
		if (!file) throw new Error("Expected the transcript to be written");
		return file;
	}

	/**
	 * A conversation at `cwd`. Top-level conversations in one room share one
	 * Settings instance, as the process does; a spawned one passes its own. The
	 * transcript is file-backed, as a real session's is, so a switch can load one.
	 */
	async function openConversation(
		cwd: string,
		options: { settings: Settings; isSpawned?: boolean },
	): Promise<Conversation> {
		const sessionManager = SessionManager.create(cwd, path.join(tempDir.path(), "sessions", String(sessions.length)));
		const { settings } = options;
		const refreshes: string[] = [];
		const moves: string[] = [];
		let failNext = false;
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel: undefined },
			}),
			isSpawned: options.isSpawned,
			sessionManager,
			settings,
			modelRegistry,
			// The real builder reads the session cwd and the settings scope; this one
			// states both, so a prompt built against the wrong scope is visible.
			rebuildSystemPrompt: async () => {
				const dir = sessionManager.getCwd();
				if (failNext) {
					failNext = false;
					throw new Error(`prompt build failed for ${dir}`);
				}
				refreshes.push(`prompt:${dir}`);
				return { systemPrompt: [`cwd=${dir} settings=${settings.getCwd()}`] };
			},
			refreshSecretRuntime: async dir => {
				refreshes.push(`secrets:${dir}`);
				return undefined;
			},
		});
		sessions.push(session);
		session.subscribe(event => {
			if (event.type === "cwd_changed") moves.push(`${event.previous} -> ${event.cwd}`);
		});
		return {
			session,
			refreshes,
			moves,
			failNextPromptBuild: () => {
				failNext = true;
			},
		};
	}

	/**
	 * A room of two: A on screen at `a`, B off screen at `b`, both on one shared
	 * Settings instance scoped to `a`, and a spare directory `c`.
	 */
	async function openRoom(): Promise<{
		a: string;
		b: string;
		c: string;
		settings: Settings;
		onScreen: Conversation;
		offScreen: Conversation;
	}> {
		const a = makeDir("project-a");
		const b = makeDir("project-b");
		const c = makeDir("project-c");
		setProjectDir(a);
		const settings = Settings.isolated();
		await settings.reloadForCwd(a);
		const onScreen = await openConversation(a, { settings });
		const offScreen = await openConversation(b, { settings });
		offScreen.session.releaseForeground();
		return { a, b, c, settings, onScreen, offScreen };
	}

	/**
	 * Every public way a session's working directory moves. Each reaches the
	 * private re-scope, which is where the background rule is enforced.
	 */
	const ENTRY_POINTS: Record<string, (session: AgentSession, destination: string) => Promise<void>> = {
		setCwd: async (session, destination) => {
			await session.setCwd(destination);
		},
		moveToCwd: async (session, destination) => {
			await session.moveToCwd(destination);
		},
		rescopeToCwd: async (session, destination) => {
			// The shape a host uses after moving the SessionManager itself.
			await session.sessionManager.setCwd(destination);
			await session.rescopeToCwd(destination);
		},
		switchSession: async (session, destination) => {
			expect(await session.switchSession(await recordTranscriptAt(destination))).toBe(true);
		},
	};

	describe("a move off screen", () => {
		/**
		 * THE BUG, stated directly: the off-screen conversation runs `set_cwd`, and
		 * the process, the shared settings scope and the on-screen conversation's
		 * runtime all stay where they were.
		 */
		it("leaves the process scope and the on-screen conversation alone", async () => {
			const { a, c, settings, onScreen, offScreen } = await openRoom();

			await offScreen.session.setCwd(c);

			expect(processScope(settings)).toEqual(scopedTo(a));
			expect(offScreen.refreshes).toEqual([]);
			expect(onScreen.refreshes).toEqual([]);
			expect(onScreen.session.sessionManager.getCwd()).toBe(a);
		});

		/**
		 * The move still happened, for the conversation that made it. Refusing it
		 * would also keep the process still, and is a different behaviour entirely.
		 */
		it("records the move on the off-screen conversation's own SessionManager", async () => {
			const { b, c, offScreen } = await openRoom();

			expect(await offScreen.session.setCwd(c)).toBe(c);

			expect(offScreen.session.sessionManager.getCwd()).toBe(c);
			expect(cwdChangedNotes(offScreen.session)).toEqual([`Session working directory changed: ${b} → ${c}`]);
			expect(offScreen.moves).toEqual([`${b} -> ${c}`]);
		});

		/**
		 * The decision for the rollback path: off screen nothing is re-scoped, so
		 * nothing can fail and nothing is rolled back. A project that cannot be
		 * scoped keeps the move and fails at the claim, which the next case covers.
		 */
		it("keeps the move when the destination's runtime would fail to build", async () => {
			const { a, c, settings, offScreen } = await openRoom();
			offScreen.failNextPromptBuild();

			expect(await offScreen.session.setCwd(c)).toBe(c);

			expect(offScreen.session.sessionManager.getCwd()).toBe(c);
			expect(processScope(settings)).toEqual(scopedTo(a));
		});

		for (const [entryPoint, move] of Object.entries(ENTRY_POINTS)) {
			/**
			 * The sweep. Each entry point, off screen, moves its own session and
			 * nothing else; the claim afterwards scopes the process to where it went.
			 */
			it(`defers the re-scope through ${entryPoint} until the claim`, async () => {
				const { a, c, settings, onScreen, offScreen } = await openRoom();

				await move(offScreen.session, c);

				expect(offScreen.session.sessionManager.getCwd()).toBe(c);
				expect(processScope(settings)).toEqual(scopedTo(a));
				expect(offScreen.refreshes).toEqual([]);

				onScreen.session.releaseForeground();
				await offScreen.session.claimForeground();

				expect(processScope(settings)).toEqual(scopedTo(c));
				expect(offScreen.session.systemPrompt).toEqual([`cwd=${c} settings=${c}`]);
				expect(offScreen.refreshes).toEqual([`secrets:${c}`, `prompt:${c}`]);
			});
		}
	});

	describe("claiming the foreground", () => {
		/**
		 * The deferred move lands, in full and in order: secrets, then the prompt,
		 * built against the settings scope the claim installed.
		 */
		it("moves the process scope to the claimed conversation's cwd", async () => {
			const { c, settings, onScreen, offScreen } = await openRoom();
			await offScreen.session.setCwd(c);

			onScreen.session.releaseForeground();
			await offScreen.session.claimForeground();

			expect(offScreen.session.isForeground).toBe(true);
			expect(onScreen.session.isForeground).toBe(false);
			expect(processScope(settings)).toEqual(scopedTo(c));
			expect(offScreen.refreshes).toEqual([`secrets:${c}`, `prompt:${c}`]);
			expect(offScreen.session.systemPrompt).toEqual([`cwd=${c} settings=${c}`]);
		});

		/**
		 * The deferred move is the trigger, not only the project dir. B moves off
		 * screen into the directory the process already holds, so the dirs agree,
		 * and B's own secrets and prompt still describe the directory it left.
		 */
		it("finishes a deferred move into the directory the process already holds", async () => {
			const { a, settings, onScreen, offScreen } = await openRoom();
			await offScreen.session.setCwd(a);

			onScreen.session.releaseForeground();
			await offScreen.session.claimForeground();

			expect(processScope(settings)).toEqual(scopedTo(a));
			expect(offScreen.refreshes).toEqual([`secrets:${a}`, `prompt:${a}`]);
			expect(offScreen.session.systemPrompt).toEqual([`cwd=${a} settings=${a}`]);
		});

		/**
		 * A finished claim consumes the deferral. Leaving it armed would re-scope on
		 * every later claim, and each is a prompt-cache invalidation.
		 */
		it("does not repeat a deferred move on the next claim", async () => {
			const { c, onScreen, offScreen } = await openRoom();
			await offScreen.session.setCwd(c);
			onScreen.session.releaseForeground();
			await offScreen.session.claimForeground();

			offScreen.session.releaseForeground();
			await offScreen.session.claimForeground();

			expect(offScreen.session.isForeground).toBe(true);
			expect(offScreen.refreshes).toEqual([`secrets:${c}`, `prompt:${c}`]);
		});

		/**
		 * The second defect. A never moved and its own guard still says `a`, but the
		 * process is in `b` because B claimed it. Bringing A back has to re-scope.
		 */
		it("re-scopes back after another conversation held the process (A to B to A)", async () => {
			const { a, b, settings, onScreen, offScreen } = await openRoom();

			onScreen.session.releaseForeground();
			await offScreen.session.claimForeground();
			expect(processScope(settings)).toEqual(scopedTo(b));

			offScreen.session.releaseForeground();
			await onScreen.session.claimForeground();

			expect(processScope(settings)).toEqual(scopedTo(a));
			expect(onScreen.refreshes).toEqual([`secrets:${a}`, `prompt:${a}`]);
			expect(onScreen.session.systemPrompt).toEqual([`cwd=${a} settings=${a}`]);
			expect(onScreen.session.isForeground).toBe(true);
			expect(offScreen.session.isForeground).toBe(false);
		});

		/**
		 * A claim that changes nothing costs nothing. Every re-scope rebuilds the
		 * prompt, and a rebuild is a full provider prompt-cache invalidation, so
		 * switching back to a conversation already in place must not pay for one.
		 */
		it("does nothing when the process is already at the cwd and no move was deferred", async () => {
			const { a, settings, onScreen } = await openRoom();

			onScreen.session.releaseForeground();
			await onScreen.session.claimForeground();

			expect(onScreen.session.isForeground).toBe(true);
			expect(onScreen.refreshes).toEqual([]);
			expect(processScope(settings)).toEqual(scopedTo(a));
		});

		/**
		 * A claim whose re-scope throws leaves the session off screen, so the caller
		 * keeps the previous one, and surfaces the error. The failure lands after the
		 * project dir moved, so the next claim must not read "already in place" and
		 * skip the half that never ran.
		 */
		it("stays in the background when the claim fails, and the next claim finishes it", async () => {
			const { b, onScreen, offScreen } = await openRoom();
			onScreen.session.releaseForeground();
			offScreen.failNextPromptBuild();

			await expect(offScreen.session.claimForeground()).rejects.toThrow(`prompt build failed for ${b}`);
			expect(offScreen.session.isForeground).toBe(false);
			expect(getProjectDir()).toBe(b);

			await offScreen.session.claimForeground();

			expect(offScreen.session.isForeground).toBe(true);
			expect(offScreen.session.systemPrompt).toEqual([`cwd=${b} settings=${b}`]);
		});

		/**
		 * A session that was foreground and fails a claim is not foreground after
		 * it: the process scope is no longer its own, whatever it held before.
		 */
		it("demotes a foreground conversation whose claim fails", async () => {
			const { a, onScreen, offScreen } = await openRoom();
			await offScreen.session.claimForeground();
			onScreen.failNextPromptBuild();

			await expect(onScreen.session.claimForeground()).rejects.toThrow(`prompt build failed for ${a}`);

			expect(onScreen.session.isForeground).toBe(false);
		});

		/**
		 * A hand-over whose claim fails partway gives the scope back: the project
		 * dir and the shared settings had already moved to the claimant's
		 * directory, and the conversation that stays on screen must be the one
		 * the process is scoped to, with its own claim's error surfaced.
		 */
		it("gives the scope back to the holder when a hand-over fails partway", async () => {
			const { a, b, settings, onScreen, offScreen } = await openRoom();
			offScreen.failNextPromptBuild();

			await expect(offScreen.session.takeForegroundFrom(onScreen.session)).rejects.toThrow(
				`prompt build failed for ${b}`,
			);

			expect({ onScreen: onScreen.session.isForeground, offScreen: offScreen.session.isForeground }).toEqual({
				onScreen: true,
				offScreen: false,
			});
			expect(processScope(settings)).toEqual(scopedTo(a));
		});

		/** A hand-over that succeeds is a plain claim: the claimant holds the scope. */
		it("moves the scope to the claimant when a hand-over succeeds", async () => {
			const { b, settings, onScreen, offScreen } = await openRoom();

			await offScreen.session.takeForegroundFrom(onScreen.session);

			expect(offScreen.session.isForeground).toBe(true);
			expect(processScope(settings)).toEqual(scopedTo(b));
		});

		/** When the holder cannot take the scope back either, both errors are thrown. */
		it("throws both errors when the holder cannot take the scope back", async () => {
			const { a, b, onScreen, offScreen } = await openRoom();
			offScreen.failNextPromptBuild();
			onScreen.failNextPromptBuild();

			const failure = await offScreen.session.takeForegroundFrom(onScreen.session).then(
				() => undefined,
				(error: unknown) => error,
			);

			expect(failure).toBeInstanceOf(AggregateError);
			const errors: unknown[] = failure instanceof AggregateError ? failure.errors : [];
			expect(errors.map(error => (error instanceof Error ? error.message : String(error)))).toEqual([
				`prompt build failed for ${b}`,
				`prompt build failed for ${a}`,
			]);
		});
	});

	describe("a spawned conversation", () => {
		/**
		 * A spawned session never drives the process. Claim and release change
		 * nothing, and its own re-root runs exactly as before: its own settings and
		 * prompt move, the process and the parent's shared settings stay.
		 */
		it("ignores claim and release and re-roots only itself", async () => {
			const parentDir = makeDir("parent-project");
			const childDir = makeDir("child-project");
			setProjectDir(parentDir);
			const shared = Settings.isolated();
			await openConversation(parentDir, { settings: shared });
			const childSettings = Settings.isolated();
			await childSettings.reloadForCwd(parentDir);
			const child = await openConversation(parentDir, { settings: childSettings, isSpawned: true });

			expect(child.session.isForeground).toBe(false);
			child.session.releaseForeground();
			await child.session.setCwd(childDir);

			expect(childSettings.getCwd()).toBe(childDir);
			expect(child.refreshes).toEqual([`secrets:${childDir}`, `prompt:${childDir}`]);
			expect(child.session.systemPrompt).toEqual([`cwd=${childDir} settings=${childDir}`]);
			expect(processScope(shared)).toEqual(scopedTo(parentDir));

			await child.session.claimForeground();

			expect(child.session.isForeground).toBe(false);
			expect(child.refreshes).toEqual([`secrets:${childDir}`, `prompt:${childDir}`]);
			expect(processScope(shared)).toEqual(scopedTo(parentDir));
		});
	});

	describe("a lone conversation", () => {
		/**
		 * NON-VACUITY. One conversation in one process is foreground from the start
		 * and moves the process on `set_cwd`, as it did before rooms. A change that
		 * deferred every re-scope would satisfy every off-screen case above.
		 */
		it("starts foreground and re-scopes the process on setCwd", async () => {
			const origin = makeDir("origin");
			const destination = makeDir("destination");
			setProjectDir(origin);
			const settings = Settings.isolated();
			const lone = await openConversation(origin, { settings });

			expect(lone.session.isForeground).toBe(true);
			await lone.session.setCwd(destination);

			expect(processScope(settings)).toEqual(scopedTo(destination));
			expect(lone.refreshes).toEqual([`secrets:${destination}`, `prompt:${destination}`]);
			expect(lone.session.systemPrompt).toEqual([`cwd=${destination} settings=${destination}`]);
			expect(cwdChangedNotes(lone.session)).toEqual([
				`Session working directory changed: ${origin} → ${destination}`,
			]);

			// The TUI's `cwd_changed` handler re-scopes the same destination again.
			await lone.session.rescopeToCwd(destination);
			expect(lone.refreshes).toEqual([`secrets:${destination}`, `prompt:${destination}`]);
		});
	});
});
