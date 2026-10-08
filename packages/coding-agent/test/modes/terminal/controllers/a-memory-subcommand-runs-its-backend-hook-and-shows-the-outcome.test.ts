/**
 * `/memory <action>` (`CommandController.handleMemoryCommand`) resolves the configured memory backend, runs the hook
 * the action names, and shows one outcome.
 *
 * Contracts:
 *  - every action the usage line lists, and each alias, reaches its own hook and nothing else;
 *  - each hook receives the agent directory, the project cwd and the session;
 *  - a hook that succeeds shows its status or panel, one that throws shows an error naming the action, and an empty
 *    result or a backend without the hook shows a warning naming the backend;
 *  - clearing memory refreshes the system prompt only after the clear succeeded;
 *  - no action, or an action in any letter case, is read the same as its lowercase form; anything else prints usage.
 *
 * The usage line is read from the controller at run time, so an action added to it without a recorded outcome here
 * fails `every action the usage line lists has a recorded outcome`.
 *
 * Gap: what each backend stores, clears or reports is owned by the backend suites; the hooks are stubbed here.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { localBackend } from "@veyyon/coding-agent/memory/local-backend";
import { mnemopiBackend } from "@veyyon/coding-agent/memory/mnemopi/backend";
import {
	CommandController,
	type CommandControllerContext,
} from "@veyyon/coding-agent/modes/terminal/controllers/command-controller";
import type { Component } from "@veyyon/tui";
import { useTruecolorTheme } from "../../../helpers/theme-assertions";

useTruecolorTheme("dark");

const AGENT_DIR = "/agent";
const CWD = "/repo";
const USAGE = "Usage: /memory <view|stats|diagnose|clear|reset|enqueue|rebuild|mm ...>";
const EMPTY_PAYLOAD = "Memory payload is empty (memory backend off, disabled, or no memory available).";

interface MemoryRun {
	statuses: string[];
	warnings: string[];
	errors: string[];
	panels: string[];
	refreshed: string[];
	session: object;
}

async function runMemory(command: string, backend: "mnemopi" | "local" = "mnemopi"): Promise<MemoryRun> {
	const run: MemoryRun = { statuses: [], warnings: [], errors: [], panels: [], refreshed: [], session: {} };
	const session = {
		refreshBaseSystemPrompt: async (reason: string) => {
			run.refreshed.push(reason);
		},
		getHindsightSessionState: () => undefined,
	};
	run.session = session;
	const ctx = {
		settings: {
			getAgentDir: () => AGENT_DIR,
			get: (key: string) => (key === "memory.backend" ? backend : undefined),
		},
		sessionManager: { getCwd: () => CWD },
		session,
		present: (block: Component) => {
			run.panels.push(stripVTControlCharacters(block.render(100).join("\n")));
		},
		showStatus: (message: string) => run.statuses.push(message),
		showWarning: (message: string) => run.warnings.push(message),
		showError: (message: string) => run.errors.push(message),
	} as unknown as CommandControllerContext;
	await new CommandController(ctx).handleMemoryCommand(command);
	return run;
}

/** Every visible outcome of a run, so a case asserts that nothing else was shown. */
function shown(run: MemoryRun) {
	return { statuses: run.statuses, warnings: run.warnings, errors: run.errors, panels: run.panels.length };
}

/** Each hook call's agent directory, cwd, and whether its session is the one `run` handed the controller. */
function hookCalls(calls: ReadonlyArray<readonly unknown[]>, run: MemoryRun) {
	return calls.map(([agentDir, cwd, session]) => [agentDir, cwd, session === run.session]);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a memory subcommand runs its backend hook and shows the outcome", () => {
	it("view shows the payload the backend injects", async () => {
		vi.spyOn(mnemopiBackend, "buildDeveloperInstructions").mockResolvedValue("Prefer tabs over spaces.");
		vi.spyOn(mnemopiBackend, "buildVolatileContext").mockResolvedValue("Recalled: the build uses bun.");
		const run = await runMemory("/memory view");
		expect(shown(run)).toEqual({ statuses: [], warnings: [], errors: [], panels: 1 });
		expect(run.panels[0]).toContain("Memory Injection Payload");
		expect(run.panels[0]).toContain("Prefer tabs over spaces.");
		expect(run.panels[0]).toContain("Recalled: the build uses bun.");
	});

	it("view of an empty payload warns instead of showing an empty panel", async () => {
		vi.spyOn(mnemopiBackend, "buildDeveloperInstructions").mockResolvedValue(undefined);
		vi.spyOn(mnemopiBackend, "buildVolatileContext").mockResolvedValue(undefined);
		const run = await runMemory("/memory view");
		expect(shown(run)).toEqual({ statuses: [], warnings: [EMPTY_PAYLOAD], errors: [], panels: 0 });
	});

	for (const action of ["clear", "reset"]) {
		it(`${action} clears the backend, then refreshes the system prompt`, async () => {
			const clear = vi.spyOn(mnemopiBackend, "clear").mockResolvedValue();
			const run = await runMemory(`/memory ${action}`);
			expect(hookCalls(clear.mock.calls, run)).toEqual([[AGENT_DIR, CWD, true]]);
			expect(run.refreshed).toEqual(["memory-clear"]);
			expect(shown(run)).toEqual({
				statuses: ["Memory data cleared and system prompt refreshed."],
				warnings: [],
				errors: [],
				panels: 0,
			});
		});

		it(`${action} that fails leaves the system prompt alone`, async () => {
			vi.spyOn(mnemopiBackend, "clear").mockRejectedValue(new Error("database is locked"));
			const run = await runMemory(`/memory ${action}`);
			expect(run.refreshed).toEqual([]);
			expect(shown(run)).toEqual({
				statuses: [],
				warnings: [],
				errors: ["Memory clear failed: database is locked"],
				panels: 0,
			});
		});
	}

	for (const action of ["enqueue", "rebuild"]) {
		it(`${action} enqueues consolidation`, async () => {
			const enqueue = vi.spyOn(mnemopiBackend, "enqueue").mockResolvedValue();
			const clear = vi.spyOn(mnemopiBackend, "clear");
			const run = await runMemory(`/memory ${action}`);
			expect(hookCalls(enqueue.mock.calls, run)).toEqual([[AGENT_DIR, CWD, true]]);
			expect(clear).not.toHaveBeenCalled();
			expect(shown(run)).toEqual({
				statuses: ["Memory consolidation enqueued."],
				warnings: [],
				errors: [],
				panels: 0,
			});
		});

		it(`${action} that fails shows the enqueue error`, async () => {
			vi.spyOn(mnemopiBackend, "enqueue").mockRejectedValue(new Error("queue full"));
			const run = await runMemory(`/memory ${action}`);
			expect(shown(run)).toEqual({
				statuses: [],
				warnings: [],
				errors: ["Memory enqueue failed: queue full"],
				panels: 0,
			});
		});
	}

	const REPORTS = [
		{ action: "stats", hook: "stats", title: "Memory Stats", other: "diagnose" },
		{ action: "diagnose", hook: "diagnose", title: "Memory Diagnostics", other: "stats" },
	] as const;

	for (const { action, hook, title, other } of REPORTS) {
		it(`${action} shows the backend's ${hook} report as a panel`, async () => {
			const called = vi.spyOn(mnemopiBackend, hook).mockResolvedValue(`## Bank\n\n${action} body`);
			const notCalled = vi.spyOn(mnemopiBackend, other);
			const run = await runMemory(`/memory ${action}`);
			expect(hookCalls(called.mock.calls, run)).toEqual([[AGENT_DIR, CWD, true]]);
			expect(notCalled).not.toHaveBeenCalled();
			expect(shown(run)).toEqual({ statuses: [], warnings: [], errors: [], panels: 1 });
			expect(run.panels[0]).toContain(title);
			expect(run.panels[0]).toContain(`${action} body`);
		});

		it(`${action} with an empty report warns that the backend has none`, async () => {
			vi.spyOn(mnemopiBackend, hook).mockResolvedValue(undefined);
			const run = await runMemory(`/memory ${action}`);
			expect(shown(run)).toEqual({
				statuses: [],
				warnings: [`Memory ${action} is not available for the mnemopi backend.`],
				errors: [],
				panels: 0,
			});
		});

		it(`${action} on a backend without the hook warns with that backend's id`, async () => {
			expect(localBackend[hook]).toBeUndefined();
			const run = await runMemory(`/memory ${action}`, "local");
			expect(shown(run)).toEqual({
				statuses: [],
				warnings: [`Memory ${action} is not available for the local backend.`],
				errors: [],
				panels: 0,
			});
		});

		it(`${action} that throws shows an error naming the action`, async () => {
			vi.spyOn(mnemopiBackend, hook).mockRejectedValue(new Error("bank unreadable"));
			const run = await runMemory(`/memory ${action}`);
			expect(shown(run)).toEqual({
				statuses: [],
				warnings: [],
				errors: [`Memory ${action} failed: bank unreadable`],
				panels: 0,
			});
		});
	}

	it("mm routes to the mental-model subcommands, which need an active Hindsight session", async () => {
		const run = await runMemory("/memory mm list");
		expect(shown(run)).toEqual({
			statuses: [],
			warnings: [],
			errors: ["Hindsight backend is not active for this session."],
			panels: 0,
		});
	});

	it("an action outside the usage line prints usage and runs no hook", async () => {
		const hooks = (["clear", "enqueue", "stats", "diagnose"] as const).map(hook => vi.spyOn(mnemopiBackend, hook));
		const run = await runMemory("/memory forget");
		expect(shown(run)).toEqual({ statuses: [], warnings: [], errors: [USAGE], panels: 0 });
		for (const hook of hooks) expect(hook).not.toHaveBeenCalled();
	});
});

describe("a memory action is read the same however it is written", () => {
	it("no action is view", async () => {
		vi.spyOn(mnemopiBackend, "buildDeveloperInstructions").mockResolvedValue(undefined);
		vi.spyOn(mnemopiBackend, "buildVolatileContext").mockResolvedValue(undefined);
		for (const command of ["/memory", "/memory ", "/memory    "]) {
			const run = await runMemory(command);
			expect(shown(run)).toEqual({ statuses: [], warnings: [EMPTY_PAYLOAD], errors: [], panels: 0 });
		}
	});

	it("an action in any letter case runs its lowercase form", async () => {
		const enqueue = vi.spyOn(mnemopiBackend, "enqueue").mockResolvedValue();
		for (const command of ["/memory ENQUEUE", "/memory Rebuild", "/memory   enqueue  extra"]) {
			const run = await runMemory(command);
			expect(run.statuses).toEqual(["Memory consolidation enqueued."]);
		}
		expect(enqueue).toHaveBeenCalledTimes(3);
	});

	it("every action the usage line lists has a recorded outcome", async () => {
		const run = await runMemory("/memory forget");
		const listed = /<([^>]*)>/
			.exec(run.errors[0] ?? "")?.[1]
			?.replace(/\s*\.\.\.$/, "")
			.split("|");
		// The actions this suite asserts above. A new action in the usage line fails here until it has cases.
		expect(listed).toEqual(["view", "stats", "diagnose", "clear", "reset", "enqueue", "rebuild", "mm"]);
	});
});
