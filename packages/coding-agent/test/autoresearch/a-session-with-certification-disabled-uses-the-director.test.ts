/**
 * WHY: When autoswarm runs with certification disabled (`certify: false`), candidate
 * arms are not cross-reviewed by each other in a ring; instead, the director is the
 * sole reviewer for every arm. In `certify-arms.ts` and `swarm.ts`, `session.certify`
 * was previously ignored, causing 3+ surviving arms to be assigned a review ring
 * regardless of the `certify` setting.
 *
 * The class it closes: any swarm review topology selector or certify_arms tool execution
 * that creates peer review rings when the session configured peer certification off.
 *
 * What it does not catch: whether the director's verdicts accurately evaluate hypotheses.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TextContent } from "@veyyon/ai";
import { createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import { closeAllAutoresearchStorages, openAutoresearchStorage } from "@veyyon/coding-agent/autoresearch/storage";
import { certificationDegraded, certificationPairs, certifierFor } from "@veyyon/coding-agent/autoresearch/swarm";
import { createCertifyArmsTool } from "@veyyon/coding-agent/autoresearch/tools/certify-arms";
import { createInitExperimentTool } from "@veyyon/coding-agent/autoresearch/tools/init-experiment";
import type { DashboardController } from "@veyyon/coding-agent/autoresearch/types";
import type { ExtensionAPI, ExtensionContext } from "@veyyon/coding-agent/extensibility/extensions";
import { TempDir } from "@veyyon/utils";
import { $ } from "bun";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();

afterEach(() => {
	vi.restoreAllMocks();
});

function firstText(content: Array<{ type: string; text?: string }>): string {
	const block = content.find((c): c is TextContent => c.type === "text");
	if (!block) throw new Error("expected a text tool content block");
	return block.text;
}

function dashboardStub(): DashboardController {
	return {
		clear(): void {},
		requestRender(): void {},
		showScreen: async (): Promise<void> => {},
		showLauncher: async (): Promise<void> => {},
		update(): void {},
	};
}

function createCtx(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		sessionManager: { getSessionId: () => "autoresearch-certify-disabled-session" },
	} as unknown as ExtensionContext;
}

const api = {
	appendEntry: () => {},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	getActiveTools: () => [],
	setActiveTools: async () => {},
} as unknown as ExtensionAPI;

let templateRepo: TempDir;
const scratch: TempDir[] = [];

beforeAll(async () => {
	templateRepo = TempDir.createSync("@pi-certify-off-template-");
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
	const dir = TempDir.createSync("@pi-certify-off-");
	scratch.push(dir);
	fs.cpSync(templateRepo.path(), dir.path(), { recursive: true });
	return dir.path();
}

describe("swarm certification disabled (certify: false)", () => {
	it("certifierFor returns director when certify is false regardless of survivor count", () => {
		expect(certifierFor(3, false)).toBe("director");
		expect(certifierFor(5, false)).toBe("director");
		expect(certifierFor(1, false)).toBe("director");
		expect(certifierFor(0, false)).toBe("void");
	});

	it("certificationPairs assigns director to all survivors when certify is false", () => {
		const candidates = [
			{ arm: "a0", hypothesis: "hyp 0", diff: "+line0\n", modifiedPaths: ["a.ts"] },
			{ arm: "a1", hypothesis: "hyp 1", diff: "+line1\n", modifiedPaths: ["b.ts"] },
			{ arm: "a2", hypothesis: "hyp 2", diff: "+line2\n", modifiedPaths: ["c.ts"] },
		];
		const pairs = certificationPairs(candidates, false);
		expect(pairs).toEqual([
			{ reviewer: "director", target: "a0" },
			{ reviewer: "director", target: "a1" },
			{ reviewer: "director", target: "a2" },
		]);
	});

	it("certificationDegraded is false when certify is false even if survivors < breadth", () => {
		expect(certificationDegraded(4, 2, false)).toBe(false);
	});

	it("certify_arms tool assigns director when session has certify: false", async () => {
		const dir = freshRepo();
		const runtime = createSessionRuntime();
		const options = { dashboard: dashboardStub(), getRuntime: () => runtime, pi: api };
		const init = createInitExperimentTool(options);
		const certify = createCertifyArmsTool(options);

		await init.execute(
			"init-1",
			{
				name: "certify off run",
				primary_metric: "ms",
				direction: "lower",
				breadth: 3,
				certify: false,
			},
			undefined,
			undefined,
			createCtx(dir),
		);

		const storage = await openAutoresearchStorage(dir);
		const session = storage.getActiveSession();
		expect(session?.certify).toBe(false);

		const result = await certify.execute(
			"call-1",
			{
				arms: [
					{
						arm: "a0",
						hypothesis: "opt a",
						diff: "--- a/src/a.ts\n+++ b/src/a.ts\n+const a = 1;\n",
						modified_paths: ["src/a.ts"],
						metric: 10,
					},
					{
						arm: "a1",
						hypothesis: "opt b",
						diff: "--- a/src/b.ts\n+++ b/src/b.ts\n+const b = 2;\n",
						modified_paths: ["src/b.ts"],
						metric: 12,
					},
					{
						arm: "a2",
						hypothesis: "opt c",
						diff: "--- a/src/c.ts\n+++ b/src/c.ts\n+const c = 3;\n",
						modified_paths: ["src/c.ts"],
						metric: 15,
					},
				],
			},
			undefined,
			undefined,
			createCtx(dir),
		);

		const text = firstText(result.content);
		expect(result.details?.certifier).toBe("director");
		expect(text).toContain("Certifier: director");
		expect(text).toContain("- director reviews a0");
		expect(text).toContain("- director reviews a1");
		expect(text).toContain("- director reviews a2");
		expect(text).not.toContain("a0 reviews a1");
		expect(text).not.toContain("Certification degraded");
	});
});
