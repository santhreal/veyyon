/**
 * Scope transitions: the serialized re-roots of a session's working directory and the re-scoping of
 * every cwd-derived input that follows one.
 *
 * This is a session collaborator. It holds the tail of the transition queue and the directory last
 * re-scoped, and reaches the session only through {@link SessionScopeHost}.
 *
 * Everything that reads the cwd is re-read when it moves, for every mode: an SDK session, an ACP
 * session, a headless run and every spawned agent, not only the TUI. The base prompt states the cwd
 * verbatim, so a session that moved without re-scoping names a directory it has left, and the model
 * reads the old project's AGENTS.md while resolving relative paths against the new one.
 */
import * as path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import { setProjectDir } from "@veyyon/utils";
import { applyProviderGlobalsFromSettings } from "../../config/provider-globals";
import type { Settings } from "../../config/settings";
import { reset as resetCapabilities } from "../../discovery/capability";
import { clearClaudePluginRootsCache } from "../../discovery/helpers";

/** The session log slice a re-root moves and records into. `SessionManager` satisfies this. */
export interface SessionScopeStore {
	getCwd(): string;
	getSessionDir(): string;
	setCwd(newCwd: string, options?: { validate?: boolean }): Promise<string>;
	moveTo(newCwd: string, targetSessionDir?: string): Promise<void>;
	appendCustomMessageEntry<T>(
		customType: string | undefined,
		content: string | undefined,
		display: boolean | undefined,
		details?: T,
		attribution?: "agent",
	): string;
}

/** What {@link SessionScope} needs from the session that holds it. */
export interface SessionScopeHost {
	readonly sessionStore: SessionScopeStore;
	/** The Settings instance owned by this session; re-scoped before any runtime candidate loads. */
	readonly settings: Settings;
	readonly agent: { appendMessage(message: AgentMessage): void };
	/** A spawned agent re-roots itself and leaves the process-global state where it is. */
	readonly isSpawned: boolean;
	refreshSecrets(): Promise<void>;
	refreshSshTool(): Promise<void>;
	refreshBaseSystemPrompt(): Promise<void>;
	/** Re-root wire path relativization at `cwd`. */
	rootWireAt(cwd: string): void;
	emitCwdChanged(previous: string, cwd: string): void;
}

export class SessionScope {
	readonly #host: SessionScopeHost;
	#tail: Promise<void> = Promise.resolve();
	#lastRescopedCwd: string | undefined;

	constructor(host: SessionScopeHost) {
		this.#host = host;
		this.#lastRescopedCwd = path.resolve(host.sessionStore.getCwd());
	}

	/** Settles once every transition started before this call has settled. */
	async ready(): Promise<void> {
		await this.#tail;
	}

	/**
	 * Run `work` after every transition started before it. A failed transition rejects only its own
	 * caller; the next one still runs.
	 */
	run<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#tail.then(work);
		this.#tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * Re-scope settings, process state, secrets, the SSH tool and the base system prompt to `cwd`.
	 * Runs inside a transition; the caller serializes it with {@link run}.
	 *
	 * The order is fixed. The base system prompt is assembled from settings, capabilities and
	 * plugin roots, so it is rebuilt LAST, once every input to it has been re-scoped. The rebuild
	 * also invalidates the provider prompt-cache key when the content changes, so the stale prefix
	 * is not re-served.
	 *
	 * REPEATING A DIRECTORY IS SKIPPED, and that is not an optimization: the TUI reaches this twice
	 * for one move. `setCwd` calls it and then emits `cwd_changed`, whose handler calls
	 * `applyCwdChange`, which calls it again for the same destination. Doing the work twice would
	 * reload settings, reset capabilities and rebuild the prompt a second time, and the rebuild is a
	 * full prompt-cache invalidation. The guard holds the LAST directory re-scoped, not every
	 * directory seen, so moving away and back still re-scopes.
	 */
	async rescope(cwd: string): Promise<void> {
		const normalizedCwd = path.resolve(cwd);
		if (this.#lastRescopedCwd === normalizedCwd) return;
		const host = this.#host;
		// Re-scope the Settings instance owned by THIS session before loading any runtime candidate.
		// The process singleton may be a different instance (SDK/embedded and spawned agent sessions
		// commonly use isolated Settings).
		await host.settings.reloadForCwd(normalizedCwd);
		// A spawned agent may not mutate process-global cwd/capability state, but its session-owned
		// settings, secrets, tools, prompt, and advisors still move.
		if (!host.isSpawned) this.#rescopeProcess(normalizedCwd);
		await host.refreshSecrets();
		await host.refreshSshTool();
		await host.refreshBaseSystemPrompt();
		this.#lastRescopedCwd = normalizedCwd;
	}

	/** Re-scope to `cwd` even when it was the last directory re-scoped: the rollback after a failure. */
	restore(cwd: string): Promise<void> {
		this.#lastRescopedCwd = undefined;
		return this.rescope(cwd);
	}

	/** Re-root the session working directory, re-scope, and record the change. Rolls back on failure. */
	setCwd(newCwd: string, options?: { validate?: boolean }): Promise<string> {
		return this.run(async () => {
			const store = this.#host.sessionStore;
			const previous = store.getCwd();
			const cwd = await store.setCwd(newCwd, options);
			if (cwd === previous) {
				await this.rescope(cwd);
				return cwd;
			}
			try {
				await this.rescope(cwd);
			} catch (error) {
				this.#lastRescopedCwd = undefined;
				try {
					await store.setCwd(previous, { validate: false });
					await this.rescope(previous);
				} catch (rollbackError) {
					throw new AggregateError(
						[error, rollbackError],
						`Failed to change cwd to ${cwd} and restore ${previous}.`,
					);
				}
				throw error;
			}
			this.#recordChange(previous, cwd);
			return cwd;
		});
	}

	/**
	 * Relocate session storage and artifacts with the complete cwd-derived runtime. A failed
	 * re-scope moves storage back before the error surfaces.
	 */
	moveTo(newCwd: string, targetSessionDir?: string): Promise<string> {
		return this.run(async () => {
			const store = this.#host.sessionStore;
			const previousCwd = store.getCwd();
			const previousSessionDir = store.getSessionDir();
			await store.moveTo(newCwd, targetSessionDir);
			const cwd = store.getCwd();
			if (cwd === previousCwd && store.getSessionDir() === previousSessionDir) {
				await this.rescope(cwd);
				return cwd;
			}
			try {
				await this.rescope(cwd);
			} catch (error) {
				this.#lastRescopedCwd = undefined;
				try {
					await store.moveTo(previousCwd, previousSessionDir);
					await this.rescope(previousCwd);
				} catch (rollbackError) {
					throw new AggregateError(
						[error, rollbackError],
						`Failed to move the session to ${cwd} and restore ${previousCwd}.`,
					);
				}
				throw error;
			}
			this.#recordChange(previousCwd, cwd);
			return cwd;
		});
	}

	/**
	 * The half of a re-root that belongs to the PROCESS, not to one session. Every line writes state
	 * shared by everything running in this process, which is why only the session that owns the
	 * process runs it; anything session-scoped belongs in {@link rescope} beside the prompt refresh.
	 */
	#rescopeProcess(cwd: string): void {
		// Align process project dir so status-line / discovery readers that still consult
		// getProjectDir() stay consistent with the live session root.
		setProjectDir(cwd);
		// Provider preferences are process-wide, but their source is the destination scope of this
		// session's Settings instance.
		applyProviderGlobalsFromSettings(this.#host.settings);
		clearClaudePluginRootsCache();
		resetCapabilities();
	}

	#recordChange(previous: string, cwd: string): void {
		const host = this.#host;
		host.rootWireAt(cwd);
		const note = `Session working directory changed: ${previous} → ${cwd}`;
		const details = { previous, cwd };
		host.agent.appendMessage({
			role: "custom",
			customType: "cwd_changed",
			content: note,
			display: true,
			details,
			attribution: "agent",
			timestamp: Date.now(),
		});
		host.sessionStore.appendCustomMessageEntry("cwd_changed", note, true, details, "agent");
		host.emitCwdChanged(previous, cwd);
	}
}
