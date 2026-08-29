/**
 * WHY: breadth lets one autoresearch iteration hold several candidate arms, and
 * an arm is a diff written by an agent that is being scored on a number. This
 * drives the real `certify_arms` and `init_experiment` tools against a real git
 * repository and a real database, proving the rules reach production rather
 * than only holding in `swarm.ts`.
 *
 * The class it closes is an arm that improves the metric without improving the
 * code, kept because nothing between the measurement and the commit looked at
 * it: an off-limits edit, an unreadable payload, a duplicate counted twice, or
 * a reviewer's flag that failed to disqualify.
 *
 * What it does not catch: whether a reviewer judges correctly. The suite proves
 * a flag is honoured, not that one was deserved.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@veyyon/ai";
import { createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import {
	type AutoresearchStorage,
	closeAllAutoresearchStorages,
	openAutoresearchStorage,
	type SessionRow,
} from "@veyyon/coding-agent/autoresearch/storage";
import { MAX_BREADTH } from "@veyyon/coding-agent/autoresearch/swarm";
import { createCertifyArmsTool } from "@veyyon/coding-agent/autoresearch/tools/certify-arms";
import { createInitExperimentTool } from "@veyyon/coding-agent/autoresearch/tools/init-experiment";
import type { AutoresearchRuntime } from "@veyyon/coding-agent/autoresearch/types";
import type { ExtensionAPI, ExtensionContext } from "@veyyon/coding-agent/extensibility/extensions";
import { TempDir } from "@veyyon/utils";
import { $ } from "bun";
import { useIsolatedAgentDir } from "./helpers/isolated-agent-dir";

useIsolatedAgentDir();

afterEach(() => {
	vi.restoreAllMocks();
});

function firstTextBlockText(content: Array<TextContent | ImageContent>): string {
	const block = content.find((c): c is TextContent => c.type === "text");
	if (!block) throw new Error("expected a text tool content block");
	return block.text;
}

function dashboardStub() {
	return {
		clear(): void {},
		requestRender(): void {},
		showOverlay: async (): Promise<void> => {},
		updateWidget(): void {},
	};
}

function createCtx(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		sessionManager: { getSessionId: () => "autoresearch-certify-test-session" },
	} as unknown as ExtensionContext;
}

const api = {
	appendEntry: () => {},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	getActiveTools: () => [],
	setActiveTools: async () => {},
} as unknown as ExtensionAPI;

function tools(runtime: AutoresearchRuntime) {
	const options = { dashboard: dashboardStub(), getRuntime: () => runtime, pi: api };
	return { certify: createCertifyArmsTool(options), init: createInitExperimentTool(options) };
}

let templateRepo: TempDir;
const scratch: TempDir[] = [];

beforeAll(async () => {
	templateRepo = TempDir.createSync("@pi-certify-template-");
	await Bun.write(path.join(templateRepo.path(), "README.md"), "# baseline\n");
	await Bun.write(path.join(templateRepo.path(), "autoresearch.sh"), "#!/usr/bin/env bash\necho METRIC ms=100\n");
	await $`git init --initial-branch=main && git config core.autocrlf false && git config core.fsmonitor false && git config user.email tester@example.com && git config user.name Tester && git add -A && git commit -m baseline && git checkout -b autoresearch/base`
		.cwd(templateRepo.path())
		.quiet();
});

afterAll(async () => {
	closeAllAutoresearchStorages();
	for (const dir of scratch) await dir.remove();
	await templateRepo.remove();
});

function freshRepo(): string {
	const dir = TempDir.createSync("@pi-certify-");
	scratch.push(dir);
	fs.cpSync(templateRepo.path(), dir.path(), { recursive: true });
	return dir.path();
}

/** Opens a session the way the agent does, through the real init tool. */
async function openSession(
	dir: string,
	runtime: AutoresearchRuntime,
	params: Record<string, unknown> = {},
): Promise<{ storage: AutoresearchStorage; session: SessionRow }> {
	const { init } = tools(runtime);
	await init.execute(
		"call-init",
		{
			name: "certify suite",
			primary_metric: "ms",
			direction: "lower",
			off_limits: ["autoresearch.sh"],
			breadth: 3,
			...params,
		} as never,
		new AbortController().signal,
		() => {},
		createCtx(dir),
	);
	const storage = await openAutoresearchStorage(dir);
	const session = storage.getActiveSession();
	if (!session) throw new Error("init_experiment did not open a session");
	return { storage, session };
}

const CLEAN_DIFF = "--- a/solution.py\n+++ b/solution.py\n+def f():\n+    return 1\n";

function arm(name: string, diff: string, metric: number, paths = ["solution.py"]) {
	return { arm: name, hypothesis: `${name} hypothesis`, diff, modified_paths: paths, metric };
}

describe("breadth reaches the session", () => {
	it("records breadth from init_experiment and clamps it to the supported range", async () => {
		const dir = freshRepo();
		const runtime = createSessionRuntime();
		const { session } = await openSession(dir, runtime, { breadth: 99 });
		expect(session.breadth).toBe(MAX_BREADTH);
		expect(session.certify).toBe(true);
		// The dashboard renders from the experiment state, not the row, so a
		// breadth that stops at the database is a breadth nobody can see.
		expect(runtime.state.breadth).toBe(MAX_BREADTH);
	});

	it("adopts the setup parked before the session existed", async () => {
		// The setup console parks its answers on the runtime because there is no
		// database yet; init must consume all three, or the console silently does
		// nothing when used in the order a user reaches for it.
		const dir = freshRepo();
		const runtime = createSessionRuntime();
		runtime.pendingSwarm = { breadth: 4, attempts: 3, certify: false };
		const { session } = await openSession(dir, runtime, { breadth: undefined });
		expect(session.breadth).toBe(4);
		expect(session.attempts).toBe(3);
		expect(session.certify).toBe(false);
		expect(runtime.pendingSwarm).toBeNull();
	});

	it("lets an explicit tool argument beat the parked setup", async () => {
		// The model may reconsider breadth from the harness it found. An argument
		// it passes deliberately outranks what was parked before it looked.
		const dir = freshRepo();
		const runtime = createSessionRuntime();
		runtime.pendingSwarm = { breadth: 4, attempts: 3, certify: false };
		const { session } = await openSession(dir, runtime, { breadth: 2 });
		expect(session.breadth).toBe(2);
		expect(session.attempts).toBe(3);
	});

	it("keeps the configured breadth when a later init does not mention it", async () => {
		const dir = freshRepo();
		const runtime = createSessionRuntime();
		await openSession(dir, runtime, { breadth: 5 });
		const { session } = await openSession(dir, runtime, { breadth: undefined });
		expect(session.breadth).toBe(5);
	});
});

describe("certify_arms", () => {
	it("refuses without an active session", async () => {
		const dir = freshRepo();
		const { certify } = tools(createSessionRuntime());
		const result = await certify.execute(
			"call-1",
			{ arms: [arm("a0", CLEAN_DIFF, 1)] } as never,
			new AbortController().signal,
			() => {},
			createCtx(dir),
		);
		expect(firstTextBlockText(result.content)).toContain("no active autoresearch session");
	});

	it("rejects an arm that edited the session's off-limits harness", async () => {
		const dir = freshRepo();
		const runtime = createSessionRuntime();
		await openSession(dir, runtime);
		const { certify } = tools(runtime);
		const result = await certify.execute(
			"call-1",
			{
				arms: [
					arm("a0", CLEAN_DIFF, 5),
					arm("a1", "--- a/autoresearch.sh\n+++ b/autoresearch.sh\n+echo METRIC ms=0\n", 0, ["autoresearch.sh"]),
				],
			} as never,
			new AbortController().signal,
			() => {},
			createCtx(dir),
		);
		const text = firstTextBlockText(result.content);
		expect(text).toContain("rejected a1: scope (autoresearch.sh)");
		expect(result.details?.survivors).toBe(1);
	});

	it("rejects a diff nobody can read before it is measured", async () => {
		const dir = freshRepo();
		const runtime = createSessionRuntime();
		await openSession(dir, runtime);
		const { certify } = tools(runtime);
		const result = await certify.execute(
			"call-1",
			{ arms: [arm("a0", CLEAN_DIFF, 5), arm("a1", `+SO = '${"QUJDRA".repeat(400)}'`, 0.01)] } as never,
			new AbortController().signal,
			() => {},
			createCtx(dir),
		);
		expect(firstTextBlockText(result.content)).toContain("rejected a1: opaque");
		expect(result.details?.survivors).toBe(1);
	});

	it("assigns a ring when three arms survive, and no arm reviews itself", async () => {
		const dir = freshRepo();
		const runtime = createSessionRuntime();
		await openSession(dir, runtime);
		const { certify } = tools(runtime);
		const result = await certify.execute(
			"call-1",
			{
				arms: [
					arm("a0", `${CLEAN_DIFF}# a0`, 9),
					arm("a1", `${CLEAN_DIFF}# a1`, 4),
					arm("a2", `${CLEAN_DIFF}# a2`, 7),
				],
			} as never,
			new AbortController().signal,
			() => {},
			createCtx(dir),
		);
		const text = firstTextBlockText(result.content);
		expect(result.details?.certifier).toBe("ring");
		expect(text).toContain("a0 reviews a1");
		expect(text).toContain("a1 reviews a2");
		expect(text).toContain("a2 reviews a0");
		expect(text).not.toContain("a0 reviews a0");
		expect(text).toContain("Ranked so far: a1=4, a2=7, a0=9");
	});

	it("reports the fallback when arms dead-end below the configured breadth", async () => {
		const dir = freshRepo();
		const runtime = createSessionRuntime();
		await openSession(dir, runtime, { breadth: 5 });
		const { certify } = tools(runtime);
		const result = await certify.execute(
			"call-1",
			{ arms: [arm("a0", `${CLEAN_DIFF}# a0`, 9), arm("a1", `${CLEAN_DIFF}# a1`, 4)] } as never,
			new AbortController().signal,
			() => {},
			createCtx(dir),
		);
		expect(firstTextBlockText(result.content)).toContain("Certification degraded");
		expect(result.details?.certifier).toBe("director");
	});

	it("picks the best unflagged arm and names it as the winner", async () => {
		const dir = freshRepo();
		const runtime = createSessionRuntime();
		await openSession(dir, runtime);
		const { certify } = tools(runtime);
		const arms = [
			arm("a0", `${CLEAN_DIFF}# a0`, 9),
			arm("a1", `${CLEAN_DIFF}# a1`, 4),
			arm("a2", `${CLEAN_DIFF}# a2`, 7),
		];
		const result = await certify.execute(
			"call-2",
			{
				arms,
				verdicts: [
					{ arm: "a0", certified_by: "a2", flagged: false },
					{ arm: "a1", certified_by: "a0", flagged: false },
					{ arm: "a2", certified_by: "a1", flagged: false },
				],
			} as never,
			new AbortController().signal,
			() => {},
			createCtx(dir),
		);
		expect(result.details?.winner).toBe("a1");
		expect(firstTextBlockText(result.content)).toContain("Winner: a1");
	});

	it("does not let the fastest arm win once a reviewer flags it", async () => {
		const dir = freshRepo();
		const runtime = createSessionRuntime();
		await openSession(dir, runtime);
		const { certify } = tools(runtime);
		const arms = [
			arm("a0", `${CLEAN_DIFF}# a0`, 9),
			arm("a1", `${CLEAN_DIFF}# a1`, 0.1),
			arm("a2", `${CLEAN_DIFF}# a2`, 7),
		];
		const result = await certify.execute(
			"call-2",
			{
				arms,
				verdicts: [
					{ arm: "a1", certified_by: "a0", flagged: true, reason: "caches by input identity" },
					{ arm: "a2", certified_by: "a1", flagged: false },
				],
			} as never,
			new AbortController().signal,
			() => {},
			createCtx(dir),
		);
		const text = firstTextBlockText(result.content);
		expect(result.details?.winner).toBe("a2");
		expect(text).toContain("flagged a1 by a0: caches by input identity");
	});

	it("reports a null round when every improvement was flagged", async () => {
		const dir = freshRepo();
		const runtime = createSessionRuntime();
		await openSession(dir, runtime);
		const { certify } = tools(runtime);
		const result = await certify.execute(
			"call-2",
			{
				arms: [arm("a0", `${CLEAN_DIFF}# a0`, 9), arm("a1", `${CLEAN_DIFF}# a1`, 4)],
				verdicts: [
					{ arm: "a1", certified_by: "a0", flagged: true, reason: "hardcodes the expected answers" },
					{ arm: "a0", certified_by: "a1", flagged: true, reason: "weakens the correctness check" },
				],
			} as never,
			new AbortController().signal,
			() => {},
			createCtx(dir),
		);
		expect(result.details?.winner).toBeNull();
		expect(firstTextBlockText(result.content)).toContain("null round");
	});

	it("states relocated cost as a measured fact rather than trusting the headline", async () => {
		// The live failure: 0.10ms reported against half a second of compilation
		// moved to import time, which the timed region never saw.
		const dir = freshRepo();
		const runtime = createSessionRuntime();
		await openSession(dir, runtime);
		const { certify } = tools(runtime);
		const result = await certify.execute(
			"call-1",
			{
				arms: [
					{ ...arm("a0", `${CLEAN_DIFF}# a0`, 0.1), cold_metric: 512.25 },
					{ ...arm("a1", `${CLEAN_DIFF}# a1`, 90), cold_metric: 2 },
				],
				baseline_cold_metric: 1.65,
			} as never,
			new AbortController().signal,
			() => {},
			createCtx(dir),
		);
		const text = firstTextBlockText(result.content);
		expect(text).toContain("a0 relocates 510.6ms of cost outside the timed region.");
		expect(text).not.toContain("a1 relocates");
	});
});
