/**
 * WHY: a session whose cwd moves re-discovers its project (context files, skills, rules, advisors)
 * before the next system prompt build. Discovery is asynchronous and a cwd can move again while it
 * runs, so three defects are possible, and each one renders one project's instructions under another
 * project's path:
 *
 *   - a discovery that finishes after the cwd moved again installs the stale project;
 *   - two overlapping refreshes both install, and the later-started one can land first;
 *   - a TTSR registration that throws partway leaves the new project's rules half-registered on
 *     the old project, or a discovery that rejects blocks every later refresh.
 *
 * The suite drives `ProjectPromptInputs` directly with controlled discovery promises, because the
 * interleavings cannot be scheduled through `createAgentSession`. `sdk-move-cwd.test.ts` proves the
 * wiring: that a real `/move` re-renders the prompt, skills and TTSR rules for the new directory.
 *
 * What it does not catch: a consumer outside the prompt that reads project inputs without going
 * through `onChange`.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Rule } from "@veyyon/coding-agent/discovery/capability/rule";
import { TtsrManager } from "@veyyon/coding-agent/export/ttsr";
import type { ProjectInputDiscovery } from "@veyyon/coding-agent/session/factory-extensions";
import {
	type DiscoveredProjectInputs,
	ProjectPromptInputs,
	type ProjectPromptSnapshot,
} from "@veyyon/coding-agent/session/prompt-inputs";

const A = path.resolve("/repo/a");
const B = path.resolve("/repo/b");
const C = path.resolve("/repo/c");

function rule(name: string, condition?: string[]): Rule {
	return {
		name,
		path: `/repo/rules/${name}.md`,
		content: "body",
		condition,
		description: condition ? undefined : `${name} description`,
		_source: { provider: "native", providerName: "native", path: `/repo/rules/${name}.md`, level: "project" },
	};
}

/** A rule whose `condition` throws when bucketing reads it. */
function rejectingRule(): Rule {
	const value = rule("rejecting");
	Object.defineProperty(value, "condition", {
		get() {
			throw new Error("condition unreadable");
		},
	});
	return value;
}

interface Harness {
	inputs: ProjectPromptInputs;
	ttsr: TtsrManager;
	discovered: string[];
	changes: DiscoveredProjectInputs[];
	/** The rendered cwd each time `onChange` ran. */
	renderedAtChange: string[];
	moveTo(cwd: string): void;
	/** Holds `cwd`'s discovery open until `release` runs; `started` resolves once discovery begins. */
	hold(cwd: string): { started: Promise<void>; release(): void };
	rulesFor: Map<string, Rule[]>;
	failNext: Set<string>;
}

function snapshot(cwd: string): ProjectPromptSnapshot {
	return {
		cwd,
		contextFiles: [{ path: path.join(cwd, "AGENTS.md"), content: cwd }],
		workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		activeRepoContext: null,
		skills: [],
		rulebookRules: [],
		alwaysApplyRules: [],
	};
}

function harness(): Harness {
	let cwd = A;
	const holds = new Map<string, { gate: Promise<void>; begin(): void }>();
	const ttsr = new TtsrManager(undefined, { getCwd: () => cwd });
	const discovered: string[] = [];
	const changes: DiscoveredProjectInputs[] = [];
	const renderedAtChange: string[] = [];
	const rulesFor = new Map<string, Rule[]>();
	const failNext = new Set<string>();
	const discover = (target: string): ProjectInputDiscovery => {
		discovered.push(target);
		const held = holds.get(target);
		holds.delete(target);
		held?.begin();
		const gate = held?.gate ?? Promise.resolve();
		const failing = failNext.delete(target);
		const after = <T>(value: T): Promise<T> =>
			gate.then(() => {
				if (failing) throw new Error(`discovery failed for ${target}`);
				return value;
			});
		const base = snapshot(target);
		// Every field is awaited together, so only the first rejection is observed; the rest are
		// handled here so the runner does not report them as unhandled.
		const discovery: ProjectInputDiscovery = {
			cwd: target,
			contextFiles: after(base.contextFiles),
			workspaceTree: after({ rootPath: target, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] }),
			activeRepoContext: after(null),
			skills: after({ skills: [], warnings: [] }),
			rules: after(rulesFor.get(target) ?? []),
			watchdogFiles: after([]),
			advisors: after({ advisors: [], sharedInstructions: undefined }),
		};
		for (const pending of Object.values(discovery)) {
			if (pending instanceof Promise) pending.catch(() => undefined);
		}
		return discovery;
	};
	const inputs: ProjectPromptInputs = new ProjectPromptInputs({
		initial: snapshot(A),
		getCwd: () => cwd,
		discover,
		ttsrManager: ttsr,
		ttsrOptions: () => ({}),
		onChange: next => {
			changes.push(next);
			renderedAtChange.push(inputs.current.cwd);
		},
	});
	return {
		inputs,
		ttsr,
		discovered,
		changes,
		renderedAtChange,
		rulesFor,
		failNext,
		moveTo(next) {
			cwd = next;
		},
		hold(target) {
			const gate = Promise.withResolvers<void>();
			const started = Promise.withResolvers<void>();
			holds.set(target, { gate: gate.promise, begin: () => started.resolve() });
			return { started: started.promise, release: () => gate.resolve() };
		},
	};
}

describe("a moved session renders one project at a time", () => {
	it("does not re-discover while the cwd is the rendered one, however it is spelled", async () => {
		const h = harness();
		// Concatenated, not `path.join`, which would normalize the `..` away before the code sees it.
		h.moveTo(`${A}${path.sep}sub${path.sep}..${path.sep}`);

		await h.inputs.refresh();

		expect(h.discovered).toEqual([]);
		expect(h.inputs.current.cwd).toBe(A);
	});

	it("installs the moved project in the snapshot before telling the consumers", async () => {
		const h = harness();
		h.rulesFor.set(B, [rule("book-b"), rule("ttsr-b", ["FORBIDDEN"])]);
		h.moveTo(B);

		await h.inputs.refresh();

		expect(h.discovered).toEqual([B]);
		expect(h.renderedAtChange).toEqual([B]);
		expect(h.inputs.current.cwd).toBe(B);
		expect(h.inputs.current.contextFiles).toEqual([{ path: path.join(B, "AGENTS.md"), content: B }]);
		expect(h.inputs.current.rulebookRules.map(r => r.name)).toEqual(["book-b"]);
		expect(h.ttsr.getRules().map(r => r.name)).toEqual(["ttsr-b"]);
		expect(h.changes.map(change => change.cwd)).toEqual([B]);
		expect(h.changes[0]?.rules.map(r => r.name)).toEqual(["book-b", "ttsr-b"]);
	});

	it("discards a discovery whose cwd moved again, and settles on the newest cwd", async () => {
		const h = harness();
		const b = h.hold(B);
		h.moveTo(B);

		const refresh = h.inputs.refresh();
		await b.started;
		h.moveTo(C);
		b.release();
		await refresh;

		expect(h.discovered).toEqual([B, C]);
		expect(h.changes.map(change => change.cwd)).toEqual([C]);
		expect(h.inputs.current.cwd).toBe(C);
	});

	it("runs overlapping refreshes one at a time, so the second sees the first's result", async () => {
		const h = harness();
		const b = h.hold(B);
		h.moveTo(B);

		const first = h.inputs.refresh();
		const second = h.inputs.refresh();
		b.release();
		await Promise.all([first, second]);

		expect(h.discovered).toEqual([B]);
		expect(h.changes.map(change => change.cwd)).toEqual([B]);
	});

	it("keeps the previous rules and project when TTSR registration throws", async () => {
		const h = harness();
		h.ttsr.addRule(rule("ttsr-a", ["OLD"]));
		h.rulesFor.set(B, [rule("ttsr-b", ["NEW"]), rejectingRule()]);
		h.moveTo(B);

		await expect(h.inputs.refresh()).rejects.toThrow("condition unreadable");

		expect(h.ttsr.getRules().map(r => r.name)).toEqual(["ttsr-a"]);
		expect(h.inputs.current.cwd).toBe(A);
		expect(h.changes).toEqual([]);
	});

	it("retries after a failed discovery instead of blocking every later refresh", async () => {
		const h = harness();
		h.failNext.add(B);
		h.moveTo(B);

		await expect(h.inputs.refresh()).rejects.toThrow(`discovery failed for ${B}`);
		expect(h.inputs.current.cwd).toBe(A);

		await h.inputs.refresh();

		expect(h.discovered).toEqual([B, B]);
		expect(h.inputs.current.cwd).toBe(B);
		expect(h.changes.map(change => change.cwd)).toEqual([B]);
	});
});
