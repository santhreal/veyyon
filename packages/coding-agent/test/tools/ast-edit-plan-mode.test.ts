/**
 * ast_edit honors plan mode's read-only working-tree invariant (fail-open fix).
 *
 * The bug this suite locks out (HUNT2-errdir-ast-edit-plan-mode-bypass, found
 * 2026-07-22, HIGH): plan mode keeps the working tree read-only, enforced solely
 * by the in-tool `enforcePlanModeWrite` guard — the write/replace/patch tools all
 * call it and hard-throw on a working-tree target even after the user approves.
 * ast_edit did NOT. Its preview runs dryRun (a harmless read, so its write-tier
 * prompt is just a preview), but the deferred apply — dispatched by the READ-tier
 * `resolve` tool, auto-approved in every mode including plan — called
 * runAstEditOnce with dryRun:false and rewrote working-tree source files on disk
 * with no guard. Plan mode was bypassed for the one tool that skipped the check.
 *
 * The fix calls enforcePlanModeWrite on every previewed target at the top of the
 * apply closure, before a single byte is written. These tests drive the real
 * preview -> resolve{apply} chain and assert the working tree is untouched in
 * plan mode, and still writable when plan mode is off (the guard is scoped).
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { ToolChoiceQueue } from "@veyyon/coding-agent/session/tool-choice-queue";
import { createTools, type ToolSession } from "@veyyon/coding-agent/tools";
import { removeWithRetries } from "@veyyon/utils";

type InvokedToolResult = {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
};

const ORIGINAL = "legacyWrap(x, value)\n";
const OPS = [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }];

function planSession(queue: ToolChoiceQueue, planEnabled: boolean): Partial<ToolSession> {
	return {
		getToolChoiceQueue: () => queue,
		buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
		steer: () => {},
		getPlanModeState: () => (planEnabled ? { enabled: true, planFilePath: "local://PLAN.md" } : { enabled: false }),
	};
}

function makeSession(cwd: string, overrides: Partial<ToolSession>): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

describe("ast_edit respects plan mode", () => {
	it("refuses to write the working tree while plan mode is active", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-plan-block-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, ORIGINAL);
			const queue = new ToolChoiceQueue();
			const tools = await createTools(makeSession(tempDir, planSession(queue, true)));
			const tool = tools.find(entry => entry.name === "ast_edit")!;

			// Preview is a read: it succeeds and queues the apply, but writes nothing.
			const preview = await tool.execute("ast-edit-preview", { ops: OPS, paths: [filePath] });
			expect((preview.details as { applied?: boolean }).applied).toBe(false);
			expect(await Bun.file(filePath).text()).toBe(ORIGINAL);
			expect(queue.hasPendingInvoker).toBe(true);

			// resolve{apply} is read-tier (auto-approved in plan mode). The guard must
			// still hard-block the disk write — the exact bypass this fixes. It throws
			// a ToolError that resolve rethrows fail-closed (resolve.ts rethrows
			// ToolError rather than swallowing it), so the apply rejects.
			const invoker = queue.peekPendingInvoker()!;
			await expect(invoker({ action: "apply", reason: "apply in plan mode" })).rejects.toThrow(
				/Plan mode.*read-only/,
			);
			// The file on disk is byte-for-byte the original: no partial rewrite.
			expect(await Bun.file(filePath).text()).toBe(ORIGINAL);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("applies normally when plan mode is off (the guard is scoped to plan mode)", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-plan-off-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, ORIGINAL);
			const queue = new ToolChoiceQueue();
			const tools = await createTools(makeSession(tempDir, planSession(queue, false)));
			const tool = tools.find(entry => entry.name === "ast_edit")!;

			await tool.execute("ast-edit-preview", { ops: OPS, paths: [filePath] });
			const invoker = queue.peekPendingInvoker()!;
			const applyResult = (await invoker({ action: "apply", reason: "apply with plan off" })) as InvokedToolResult;

			expect(applyResult.isError).toBeUndefined();
			expect(await Bun.file(filePath).text()).toContain("modernWrap(x, value)");
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
