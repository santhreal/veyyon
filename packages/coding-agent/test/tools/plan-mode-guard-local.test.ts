import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PlanModeState } from "@veyyon/coding-agent/plan-mode/state";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { enforcePlanModeWrite, resolvePlanPath } from "@veyyon/coding-agent/tools/plan-mode-guard";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

const ARTIFACTS_DIR = path.join(os.tmpdir(), "agent-artifacts");
const REPO_ROOT = path.join(os.tmpdir(), "repo");
const PLANS_DIR = path.join(os.tmpdir(), "plans");

interface SessionOverrides {
	artifactsDir?: string | null;
	sessionId?: string | null;
	cwd?: string;
	planMode?: PlanModeState;
}

function makeSession(overrides: SessionOverrides): ToolSession {
	return makeToolSession({
		cwd: overrides.cwd ?? REPO_ROOT,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: {
			// Every setting falls to its own default; only the plans directory is
			// steered. `get` is part of the stub contract so a test cannot forget it.
			get: () => undefined,
			getPlansDirectory: () => PLANS_DIR,
		},
		getArtifactsDir: () => overrides.artifactsDir ?? null,
		getSessionId: () => overrides.sessionId ?? null,
		getPlanModeState: () => overrides.planMode,
	});
}

describe("resolvePlanPath local:// support", () => {
	it("resolves local:// paths under session artifacts local root", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, sessionId: "abc" });
		expect(resolvePlanPath(session, "local://handoffs/result.json")).toBe(
			path.join(ARTIFACTS_DIR, "local", "handoffs", "result.json"),
		);
	});

	it("falls back to os tmp root when artifacts dir is unavailable", () => {
		const session = makeSession({ artifactsDir: null, sessionId: "session-42" });
		expect(resolvePlanPath(session, "local://memo.txt")).toBe(
			path.join(os.tmpdir(), "veyyon-local", "session-42", "memo.txt"),
		);
	});
});

describe("resolvePlanPath resolves literally (no plan-mode redirect)", () => {
	const planMode: PlanModeState = { enabled: true, planFilePath: "local://some-plan.md" };

	it("resolves a bare path against cwd regardless of plan mode", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, cwd: REPO_ROOT, planMode });
		expect(resolvePlanPath(session, "PLAN.md")).toBe(path.join(REPO_ROOT, "PLAN.md"));
		expect(resolvePlanPath(session, "src/foo.ts")).toBe(path.join(REPO_ROOT, "src", "foo.ts"));
	});

	it("resolves a local:// plan file to the session local root", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, planMode });
		expect(resolvePlanPath(session, "local://some-plan.md")).toBe(path.join(ARTIFACTS_DIR, "local", "some-plan.md"));
	});

	it("unwraps a `[PATH#TAG]` hashline header to the inner filesystem path", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, planMode });
		const planPath = path.join(ARTIFACTS_DIR, "local", "some-plan.md");
		expect(resolvePlanPath(session, "[local://some-plan.md#ABCD]")).toBe(planPath);
		expect(resolvePlanPath(session, `[${planPath}#ABCD]`)).toBe(planPath);
		expect(resolvePlanPath(session, "[local://some-plan.md]")).toBe(planPath);
	});

	it("leaves malformed bracketed paths untouched so downstream errors surface", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, cwd: REPO_ROOT, planMode });
		// Inner path with a non-tag `#`, selector tail, or empty body falls outside
		// the strict header shape and is resolved literally against the session cwd
		// so the eventual write/edit reports a real "file not found" instead of
		// silently rewriting the target.
		const nonHexHeader = `[${path.join(ARTIFACTS_DIR, "x")}#nothex]`;
		const selectorHeader = `[${path.join(ARTIFACTS_DIR, "x")}#ABCD:1-2]`;
		expect(resolvePlanPath(session, nonHexHeader)).toBe(path.join(REPO_ROOT, nonHexHeader));
		expect(resolvePlanPath(session, selectorHeader)).toBe(path.join(REPO_ROOT, selectorHeader));
	});
});

describe("enforcePlanModeWrite (working tree read-only, local:// sandbox writable)", () => {
	const planMode: PlanModeState = { enabled: true, planFilePath: "local://some-plan.md" };

	it("accepts writes to any local:// file", () => {
		// WHY: acceptance only means something next to the boundary it sits on. The
		// guard authorizes by DESTINATION, so the same test pins the nearest path
		// that is NOT in the sandbox; without it, a guard that had stopped checking
		// anything at all would pass.
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, planMode });
		expect(() => enforcePlanModeWrite(session, "local://auth-refactor-plan.md", { op: "create" })).not.toThrow();
		expect(() => enforcePlanModeWrite(session, "local://scratch/notes.md", { op: "update" })).not.toThrow();
		expect(() =>
			enforcePlanModeWrite(session, path.join(ARTIFACTS_DIR, "local", "..", "escape.md"), { op: "update" }),
		).toThrow(/working tree is read-only/);
	});

	it("rejects writes to the working tree", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, cwd: REPO_ROOT, planMode });
		expect(() => enforcePlanModeWrite(session, "src/foo.ts", { op: "update" })).toThrow(/working tree is read-only/);
		expect(() => enforcePlanModeWrite(session, "PLAN.md", { op: "create" })).toThrow(/working tree is read-only/);
	});

	it("rejects deletes and renames outright", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, planMode });
		expect(() => enforcePlanModeWrite(session, "local://some-plan.md", { op: "delete" })).toThrow(
			/deleting files is not allowed/,
		);
		expect(() => enforcePlanModeWrite(session, "local://some-plan.md", { move: "local://renamed.md" })).toThrow(
			/renaming files is not allowed/,
		);
	});

	it("is a no-op when plan mode is disabled", () => {
		// WHY: asserted as the on/off transition rather than as a bare "did not
		// throw". The same call on the same path has to be refused with plan mode on
		// and inert with it off, which a guard stuck in either position fails.
		const off = makeSession({ artifactsDir: ARTIFACTS_DIR, cwd: REPO_ROOT });
		const on = makeSession({ artifactsDir: ARTIFACTS_DIR, cwd: REPO_ROOT, planMode });
		for (const options of [{ op: "update" }, { op: "delete" }, { move: "src/bar.ts" }] as const) {
			expect(() => enforcePlanModeWrite(off, "src/foo.ts", options)).not.toThrow();
			expect(() => enforcePlanModeWrite(on, "src/foo.ts", options)).toThrow(/Plan mode:/);
		}
	});
});

describe("enforcePlanModeWrite accepts absolute local-sandbox paths", () => {
	const planMode: PlanModeState = { enabled: true, planFilePath: "local://some-plan.md" };

	it("allows the absolute path returned by `read local://...` (== sandbox-resolved path)", async () => {
		// WHY: the model reads `local://my-plan.md`, gets an absolute path back, and
		// writes to that. The guard has to recognise the round-tripped spelling as
		// the same sandbox target, and it has to stop one directory above it, which
		// is the assertion that keeps "recognised" from meaning "waved through".
		//
		// Use an existing temp directory so the realpath check inside the guard
		// sees a real filesystem even when the OS exposes temp paths through aliases.
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-guard-test-"));
		try {
			const session = makeSession({ artifactsDir, planMode });
			const absolute = resolvePlanPath(session, "local://my-plan.md");
			const justOutside = path.resolve(path.dirname(absolute), "..", "escape.md");
			expect(() => enforcePlanModeWrite(session, absolute, { op: "update" })).not.toThrow();
			expect(() => enforcePlanModeWrite(session, justOutside, { op: "update" })).toThrow(
				/working tree is read-only/,
			);
		} finally {
			await removeWithRetries(artifactsDir);
		}
	});

	it("allows bracketed hashline headers for local sandbox paths", async () => {
		// WHY: authorization runs on the UNWRAPPED path. Every strict header shape
		// wrapping a sandbox target is accepted, and the same shape wrapping a path
		// one directory above the sandbox is still refused, so the unwrap is not a
		// way to smuggle a working-tree write past the destination check.
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-guard-test-"));
		try {
			const session = makeSession({ artifactsDir, planMode });
			const absolute = resolvePlanPath(session, "local://my-plan.md");

			// Strict hashline shape `[PATH]` or `[PATH#XXXX]` is unwrapped to the
			// inner path for both the sandbox check and the eventual resolution.
			expect(() => enforcePlanModeWrite(session, `[${absolute}#ABCD]`, { op: "update" })).not.toThrow();
			expect(() => enforcePlanModeWrite(session, `[${absolute}]`, { op: "update" })).not.toThrow();
			expect(() => enforcePlanModeWrite(session, `[local://my-plan.md#ABCD]`, { op: "update" })).not.toThrow();

			const justOutside = path.resolve(path.dirname(absolute), "..", "escape.md");
			expect(() => enforcePlanModeWrite(session, `[${justOutside}#ABCD]`, { op: "update" })).toThrow(
				/working tree is read-only/,
			);
		} finally {
			await removeWithRetries(artifactsDir);
		}
	});

	it("rejects malformed bracketed headers instead of silently unwrapping them", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, cwd: REPO_ROOT, planMode });
		const sandboxPlanPath = path.join(ARTIFACTS_DIR, "local", "plan.md");

		// Selector tails (`#TAG:lines`), non-hex tags, and short tags fall outside
		// the strict header shape; we leave them alone so the downstream resolver
		// surfaces the real error rather than treating the bracketed blob as a path.
		expect(() => enforcePlanModeWrite(session, `[${sandboxPlanPath}#ABCD:1-2]`, { op: "update" })).toThrow(
			/working tree is read-only/,
		);
		expect(() => enforcePlanModeWrite(session, `[${sandboxPlanPath}#nothex]`, { op: "update" })).toThrow(
			/working tree is read-only/,
		);
	});

	it("still rejects absolute paths outside the local sandbox", () => {
		const session = makeSession({ artifactsDir: ARTIFACTS_DIR, cwd: REPO_ROOT, planMode });
		const workingTreePath = path.join(REPO_ROOT, "src", "foo.ts");

		expect(() => enforcePlanModeWrite(session, workingTreePath, { op: "update" })).toThrow(
			/working tree is read-only/,
		);
		expect(() => enforcePlanModeWrite(session, `[${workingTreePath}#ABCD]`, { op: "update" })).toThrow(
			/working tree is read-only/,
		);
	});
});
