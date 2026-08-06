/**
 * Plan mode keeps the working tree read-only, and no spelling of a tool call
 * gets around it.
 *
 * WHY THIS SUITE EXISTS (PERM-2). Plan mode is a promise to the user: the agent
 * may look and may draft, but it will not change the project. A promise like that
 * is only as good as its weakest path, and a permission check that can be dodged
 * is worse than none, because the user relaxes on the strength of it.
 *
 * THE DEFENCE IS TWO LAYERS, and they answer different questions. Testing only
 * one leaves the other free to regress:
 *
 *   1. `planAutonomyBlocksMutation` (approval.ts) refuses by TIER. This is the
 *      part that cannot be dodged by renaming: it never looks at a tool's name,
 *      only at the tier its own `approval` decision reports, and a tool that
 *      declares nothing defaults to `exec`. So an alias, a wire name, or a
 *      brand-new unannotated tool is refused by default rather than admitted by
 *      default. That is the property PERM-2 is really asking about, and it is
 *      asserted directly below rather than inferred.
 *
 *   2. `enforcePlanModeWrite` (plan-mode-guard.ts) refuses by DESTINATION. With
 *      plan mode ACTIVE the write tier is deliberately let through the first
 *      layer, because the agent has to be able to write its plan somewhere. The
 *      guard is what makes that safe: writes are confined to the `local://`
 *      artifact sandbox, and renames and deletes are refused outright.
 *
 * The second layer is the subtle one. Reading approval.ts alone, line
 * `if (options?.planModeActive && tier === "write") return false;` looks like
 * plan mode ALLOWS writes. It does, at that layer, and the guard is the reason
 * that is not a hole. Both halves are pinned here so neither can be removed on
 * the belief that the other covers it.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { requiresApproval, resolveApproval } from "@veyyon/coding-agent/tools/approval";
import { enforcePlanModeWrite } from "@veyyon/coding-agent/tools/plan-mode-guard";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

// Tracked temp directories: the factory deletes what it made when this file finishes.
// These call sites used a bare `mkdtempSync` with no teardown, so every run left the
// directory in `/tmp` forever. Cleanup is attached to creation so a new case cannot
// reintroduce the leak by forgetting an `afterAll`.
const makePlanGuardDir = useTrackedTempDirs("veyyon-plan-guard-");

/** A tool stub carrying only what the approval resolver reads: a name and a
 * tier decision. Names are deliberately varied to show they are not consulted. */
const toolWithTier = (name: string, tier?: "read" | "write" | "exec") => ({
	name,
	...(tier ? { approval: () => tier } : {}),
});

/**
 * Resolve approval under plan AUTONOMY (the ladder rung), not active plan mode.
 *
 * Uses `resolveApproval`, the pure decision, rather than `requiresApproval`,
 * which THROWS on a deny. The distinction matters for what these tests can say:
 * asserting on the returned policy and tier states which decision was reached,
 * where catching an exception would only show that something refused.
 */
const underPlanAutonomy = (tool: object) => resolveApproval(tool as never, {}, "plan", {}, {});

/** Resolve approval under ACTIVE plan mode, where the write tier is let through
 * to the guard. */
const underActivePlanMode = (tool: object) => resolveApproval(tool as never, {}, "plan", {}, { planModeActive: true });

describe("plan autonomy refuses by tier, so a name cannot dodge it", () => {
	/**
	 * THE anti-bypass property. Four tools with wildly different names and the
	 * same mutating tier all get the same answer, because the resolver never reads
	 * the name. A check keyed on a list of known tool names would pass three of
	 * these and fail the fourth.
	 */
	it.each([
		["write", "write"],
		["edit", "write"],
		["some_vendor_write_alias", "write"],
		["mcp__vendor__apply_patch", "write"],
	] as const)("denies %s at the write tier", (name, tier) => {
		expect(underPlanAutonomy(toolWithTier(name, tier)).policy).toBe("deny");
	});

	/** Same for exec, which is the tier that can do anything at all. */
	it.each(["bash", "ssh", "eval", "totally_new_exec_tool"])("denies the exec tool %s", name => {
		expect(underPlanAutonomy(toolWithTier(name, "exec")).policy).toBe("deny");
	});

	/**
	 * FAIL-CLOSED BY DEFAULT, and the single most important assertion here. A tool
	 * that declares no `approval` at all is treated as `exec`, so a newly added
	 * tool is refused in plan mode until someone deliberately marks it as a read.
	 * The opposite default would silently admit every future tool.
	 */
	it("denies a tool that declares no approval tier at all", () => {
		const result = underPlanAutonomy({ name: "unannotated_new_tool" });
		expect(result.policy).toBe("deny");
		expect(result.tier).toBe("exec");
	});

	/** Reads are allowed, or the denials above would be indistinguishable from
	 * plan mode simply refusing everything. */
	it.each(["read", "grep", "glob"])("allows the read tool %s", name => {
		expect(underPlanAutonomy(toolWithTier(name, "read")).policy).not.toBe("deny");
	});

	/** The reason must tell the user how to proceed. "Denied" with no next step
	 * reads as a malfunction. */
	it("explains that raising autonomy is the way forward", () => {
		const result = underPlanAutonomy(toolWithTier("write", "write"));
		expect(result.reason).toContain("ask");
		expect(result.reason).toContain("non-mutating");
	});

	/**
	 * The caller-facing half. Tools do not read the policy, they call
	 * `requiresApproval`, which turns a deny into a THROW carrying that same
	 * reason. A refactor that returned the deny instead of throwing would let
	 * every caller treat it as "no approval needed".
	 */
	it("throws the reason to the caller rather than returning it", () => {
		expect(() => requiresApproval(toolWithTier("write", "write") as never, {}, "plan", {}, {})).toThrow(
			/non-mutating tools only/,
		);
	});
});

describe("active plan mode lets the write tier reach the guard, on purpose", () => {
	/**
	 * Pins the deliberate carve-out. If this ever became `deny`, the agent could
	 * not write its own plan file and plan mode would be useless; if the GUARD
	 * below were removed while this stayed, the working tree would be writable.
	 * The pair is the contract.
	 */
	it("does not deny the write tier when plan mode is active", () => {
		expect(underActivePlanMode(toolWithTier("write", "write")).policy).not.toBe("deny");
	});

	/** Exec stays denied even with plan mode active: there is no plan-drafting
	 * reason to run a command. */
	it("still denies the exec tier when plan mode is active", () => {
		expect(underActivePlanMode(toolWithTier("bash", "exec")).policy).toBe("deny");
	});
});

describe("the guard confines active plan-mode writes to the local sandbox", () => {
	const root = makePlanGuardDir();
	const artifacts = path.join(root, "artifacts");
	fs.mkdirSync(artifacts, { recursive: true });

	/** A session with plan mode ON and a real `local://` sandbox root. */
	const planSession = {
		cwd: root,
		getPlanModeState: () => ({ enabled: true }),
		getArtifactsDir: () => artifacts,
		getSessionId: () => "plan-session",
	};
	/** The same session with plan mode OFF, used as the differential. */
	const normalSession = { ...planSession, getPlanModeState: () => ({ enabled: false }) };

	const guard = (target: string, options?: { move?: string; op?: "create" | "update" | "delete" }) =>
		enforcePlanModeWrite(planSession as never, target, options);

	/**
	 * THE working-tree refusal, spelled the several ways a model actually writes a
	 * path. Each takes a different branch through resolution, and one of them
	 * getting through would be a complete bypass.
	 */
	it.each([
		["relative", "src/main.ts"],
		["dot-relative", "./src/main.ts"],
		["absolute", path.join(root, "src", "main.ts")],
		["parent traversal", "../escape.ts"],
		["absolute elsewhere", "/etc/hosts"],
	])("refuses a %s path into the working tree", (_label, target) => {
		expect(() => guard(target)).toThrow(/working tree is read-only/);
	});

	/** The plan file itself must be writable, or plan mode cannot do its job.
	 * This is the differential for every refusal above. */
	it("allows a write to the local:// sandbox", () => {
		// WHY: paired with the nearest path that is NOT the sandbox, one directory
		// above it. Acceptance on its own also holds for a guard that has stopped
		// checking the destination, which is the hole this suite exists to close.
		expect(() => guard("local://feature-plan.md")).not.toThrow();
		expect(() => guard(path.join(artifacts, "local", "..", "..", "escape.md"))).toThrow(/working tree is read-only/);
	});

	/**
	 * Renames and deletes are refused BEFORE the destination is even considered,
	 * because a rename out of the sandbox and a delete of a tracked file are both
	 * working-tree changes that no destination check would catch.
	 */
	it("refuses a rename even when the target is in the sandbox", () => {
		expect(() => guard("local://plan.md", { move: "local://other.md" })).toThrow(/renaming files is not allowed/);
	});

	it("refuses a delete even when the target is in the sandbox", () => {
		expect(() => guard("local://plan.md", { op: "delete" })).toThrow(/deleting files is not allowed/);
	});

	/** The message must name the alternative, since a model that is only told
	 * "no" retries the same call. */
	it("tells the caller to write a local:// plan file instead", () => {
		let message = "";
		try {
			guard("src/main.ts");
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("local://");
		expect(message).toContain("plan.md");
	});

	/** With plan mode OFF the guard must be inert, or it would block ordinary
	 * work. This proves the refusals above are plan mode and not the guard
	 * rejecting everything. */
	it("does nothing when plan mode is off", () => {
		// WHY: the same three calls, refused with plan mode on and inert with it off.
		// Asserting only the inert half would pass against a guard that never
		// refuses anything.
		for (const options of [{ op: "update" }, { op: "delete" }, { move: "src/b.ts" }] as const) {
			expect(() => enforcePlanModeWrite(normalSession as never, "src/main.ts", options)).not.toThrow();
			expect(() => enforcePlanModeWrite(planSession as never, "src/main.ts", options)).toThrow(/Plan mode:/);
		}
	});
});
