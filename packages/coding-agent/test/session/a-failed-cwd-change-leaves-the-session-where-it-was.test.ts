/**
 * WHY THIS SUITE EXISTS. `SessionScope` moves a session's working directory and re-reads everything
 * derived from it: settings, secrets, the SSH tool and the base system prompt, in that order. A move that
 * failed halfway and stayed there would leave the session log in one directory and the prompt describing
 * another; two moves that interleaved would re-scope against a directory the log had already left; and a
 * prompt rebuilt before the settings moved would describe the old project.
 *
 * THE CLASS. Every transition outcome: a move that succeeds records itself once, a move whose re-scope
 * fails rolls the log and the scope back and records nothing, a rollback that also fails reports both
 * errors, a repeated directory is not re-scoped, and transitions run one after another with a failure
 * rejecting only its own caller. The host is a recording fake with `isSpawned` set, so no process-wide
 * state moves; the store is a fake of the session log's directory fields.
 *
 * WHAT IT DOES NOT CATCH. The process-wide half of a re-root (project dir, provider globals, capability
 * cache), which runs only for an unspawned session; and `moveTo`, which shares the rollback shape with
 * `setCwd` and is driven through the session suites.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	SessionScope,
	type SessionScopeHost,
	type SessionScopeStore,
} from "@veyyon/coding-agent/session/runtime/session-scope";

const START = path.resolve("/srv/checkout/alpha");
const NEXT = path.resolve("/srv/checkout/beta");
const LATER = path.resolve("/srv/checkout/gamma");

/** The session log's directory fields, recording each change it is asked for. */
class FakeStore implements SessionScopeStore {
	cwd = START;
	readonly cwdCalls: Array<{ cwd: string; validate: boolean | undefined }> = [];
	readonly entries: Array<{ customType: string | undefined; details: unknown }> = [];

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return path.join(this.cwd, ".sessions");
	}

	async setCwd(newCwd: string, options?: { validate?: boolean }): Promise<string> {
		this.cwdCalls.push({ cwd: newCwd, validate: options?.validate });
		this.cwd = path.resolve(newCwd);
		return this.cwd;
	}

	async moveTo(newCwd: string): Promise<void> {
		this.cwd = path.resolve(newCwd);
	}

	appendCustomMessageEntry<T>(
		customType: string | undefined,
		_content: string | undefined,
		_display: boolean | undefined,
		details?: T,
	): string {
		this.entries.push({ customType, details });
		return `entry-${this.entries.length}`;
	}
}

interface Recorder {
	readonly store: FakeStore;
	readonly settings: Settings;
	/** Each re-scope step in the order it ran, with the directory the settings were scoped to at that point. */
	readonly steps: string[];
	readonly messages: AgentMessage[];
	readonly emitted: Array<{ previous: string; cwd: string }>;
	readonly roots: string[];
	/** Directories whose prompt rebuild throws. */
	readonly failPromptAt: Set<string>;
	readonly scope: SessionScope;
}

function recorder(): Recorder {
	const store = new FakeStore();
	const settings = Settings.isolated();
	const steps: string[] = [];
	const messages: AgentMessage[] = [];
	const emitted: Array<{ previous: string; cwd: string }> = [];
	const roots: string[] = [];
	const failPromptAt = new Set<string>();
	const host: SessionScopeHost = {
		sessionStore: store,
		settings,
		agent: { appendMessage: message => messages.push(message) },
		isSpawned: true,
		refreshSecrets: async () => {
			steps.push(`secrets@${settings.getCwd()}`);
		},
		refreshSshTool: async () => {
			steps.push(`ssh@${settings.getCwd()}`);
		},
		refreshBaseSystemPrompt: async () => {
			steps.push(`prompt@${settings.getCwd()}`);
			if (failPromptAt.has(settings.getCwd())) throw new Error(`prompt rebuild failed at ${settings.getCwd()}`);
		},
		rootWireAt: cwd => roots.push(cwd),
		emitCwdChanged: (previous, cwd) => emitted.push({ previous, cwd }),
	};
	return { store, settings, steps, messages, emitted, roots, failPromptAt, scope: new SessionScope(host) };
}

describe("a failed cwd change leaves the session where it was", () => {
	it("re-scopes settings first and the base prompt last, then records the move once", async () => {
		const r = recorder();

		await expect(r.scope.setCwd(NEXT)).resolves.toBe(NEXT);

		expect(r.steps).toEqual([`secrets@${NEXT}`, `ssh@${NEXT}`, `prompt@${NEXT}`]);
		expect(r.roots).toEqual([NEXT]);
		expect(r.emitted).toEqual([{ previous: START, cwd: NEXT }]);
		expect(r.store.entries).toEqual([{ customType: "cwd_changed", details: { previous: START, cwd: NEXT } }]);
		expect(r.messages.map(message => (message.role === "custom" ? message.customType : message.role))).toEqual([
			"cwd_changed",
		]);
	});

	it("moves the log and the scope back when the re-scope fails, and records nothing", async () => {
		const r = recorder();
		r.failPromptAt.add(NEXT);

		await expect(r.scope.setCwd(NEXT)).rejects.toThrow(`prompt rebuild failed at ${NEXT}`);

		expect(r.store.cwd).toBe(START);
		expect(r.store.cwdCalls).toEqual([
			{ cwd: NEXT, validate: undefined },
			{ cwd: START, validate: false },
		]);
		// The start directory is re-scoped although it was the last one before the attempt.
		expect(r.steps.slice(-3)).toEqual([`secrets@${START}`, `ssh@${START}`, `prompt@${START}`]);
		expect(r.settings.getCwd()).toBe(START);
		expect(r.roots).toEqual([]);
		expect(r.emitted).toEqual([]);
		expect(r.store.entries).toEqual([]);
		expect(r.messages).toEqual([]);
	});

	it("reports both errors when the rollback fails as well", async () => {
		const r = recorder();
		r.failPromptAt.add(NEXT);
		r.failPromptAt.add(START);

		const failure = await r.scope.setCwd(NEXT).then(
			() => undefined,
			(error: unknown) => error,
		);

		if (!(failure instanceof AggregateError)) throw new Error(`expected an AggregateError, got ${String(failure)}`);
		expect(failure.message).toBe(`Failed to change cwd to ${NEXT} and restore ${START}.`);
		expect(failure.errors.map(error => (error instanceof Error ? error.message : String(error)))).toEqual([
			`prompt rebuild failed at ${NEXT}`,
			`prompt rebuild failed at ${START}`,
		]);
	});

	it("re-scopes a directory again only after the session has left it", async () => {
		const r = recorder();

		await r.scope.rescope(NEXT);
		await r.scope.rescope(NEXT);
		expect(r.steps.filter(step => step.startsWith("prompt@"))).toEqual([`prompt@${NEXT}`]);

		await r.scope.rescope(START);
		await r.scope.rescope(NEXT);
		expect(r.steps.filter(step => step.startsWith("prompt@"))).toEqual([
			`prompt@${NEXT}`,
			`prompt@${START}`,
			`prompt@${NEXT}`,
		]);
	});

	it("runs moves one after another, and a failed one rejects only its own caller", async () => {
		const r = recorder();
		r.failPromptAt.add(NEXT);

		const first = r.scope.setCwd(NEXT);
		const second = r.scope.setCwd(LATER);
		const outcomes = await Promise.allSettled([first, second]);

		expect(outcomes.map(outcome => outcome.status)).toEqual(["rejected", "fulfilled"]);
		// The second move started from where the first one's rollback left the log.
		expect(r.emitted).toEqual([{ previous: START, cwd: LATER }]);
		expect(r.store.cwdCalls.map(call => call.cwd)).toEqual([NEXT, START, LATER]);
		expect(r.store.cwd).toBe(LATER);
	});
});
