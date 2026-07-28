/**
 * An active plan-mode session blocks exec, including for a tool the operator set to `allow`.
 *
 * THE BUG. `resolveApprovalInner` consulted the per-tool policy before the plan block:
 *
 *     if (userPolicy) return { policy: userPolicy, ... };        // ran first
 *     if (planAutonomyBlocksMutation(level, tier, options)) ...   // never reached
 *
 * Plan mode is built as a CAP rather than a default. `resolveEffectiveApprovalMode` forces the level
 * to `plan` whenever a plan-mode session is active, specifically so a configured `yolo` cannot beat
 * it, and `bypassAllApprovals` documents the plan-mode mutation block as one of the two things it
 * never lifts. A per-tool `allow` reintroduced that escape one tool at a time: `tools.approval.bash
 * = "allow"` ran shell commands inside plan mode, so "mutating tools are blocked" held only for
 * operators who had never configured a tool.
 *
 * WHERE THE LINE IS. The cap applies to an ACTIVE plan-mode session, not to `plan` merely being the
 * configured autonomy level. A configured level and a configured per-tool policy are two settings
 * from the same operator and the documented resolution order lets the narrower one win. An active
 * session is a live mode the operator entered, and it outranks both. A `deny` is a hard block in
 * every direction and is never relaxed by any of this.
 */
import { describe, expect, it } from "bun:test";
import { resolveApproval } from "@veyyon/coding-agent/tools/approval";

const bash = { name: "bash", approval: () => ({ tier: "exec" as const }) };
const write = { name: "write", approval: () => ({ tier: "write" as const }) };
const read = { name: "read", approval: () => ({ tier: "read" as const }) };

describe("an active plan-mode session against a per-tool allow", () => {
	/** THE REGRESSION. Exec is blocked even though the operator allowed this tool. */
	it("denies an exec tool the operator set to allow", () => {
		const r = resolveApproval(bash, {}, "plan", { bash: "allow" }, { planModeActive: true });
		expect(r.policy).toBe("deny");
		expect(r.reason).toBe("Plan mode: mutating tools are blocked (draft the plan via local:// plan files only).");
	});

	/** The same call with nothing configured, so the fix is shown to close a gap, not open one. */
	it("denies the same exec tool with nothing configured", () => {
		expect(resolveApproval(bash, {}, "plan", {}, { planModeActive: true }).policy).toBe("deny");
	});

	/** A configured prompt cannot buy execution either. */
	it("denies an exec tool the operator set to prompt", () => {
		expect(resolveApproval(bash, {}, "plan", { bash: "prompt" }, { planModeActive: true }).policy).toBe("deny");
	});

	/** A deny is a hard block and must be returned as one, not converted into the plan reason. */
	it("keeps a configured deny as a deny", () => {
		const r = resolveApproval(bash, {}, "plan", { bash: "deny" }, { planModeActive: true });
		expect(r.policy).toBe("deny");
		expect(r.reason).toBeUndefined();
	});

	/** The bypass documents the plan block as unliftable. That has to hold with a policy set too. */
	it("is not lifted by the /yolo bypass", () => {
		const r = resolveApproval(
			bash,
			{},
			"plan",
			{ bash: "allow" },
			{ planModeActive: true, bypassAllApprovals: true },
		);
		expect(r.policy).toBe("deny");
	});
});

describe("what the plan-mode cap must leave alone", () => {
	/**
	 * Write tier stays reachable in an active plan-mode session: the plan itself is a file the agent
	 * has to write. `planAutonomyBlocksMutation` exempts write while the session is active, and a
	 * configured `allow` on a write tool must keep working.
	 */
	it("still honors a per-tool allow on a write tool", () => {
		expect(resolveApproval(write, {}, "plan", { write: "allow" }, { planModeActive: true }).policy).toBe("allow");
	});

	/** Reads were never mutations and are untouched. */
	it("still allows reads", () => {
		expect(resolveApproval(read, {}, "plan", {}, { planModeActive: true }).policy).toBe("allow");
		expect(resolveApproval(read, {}, "plan", { read: "allow" }, { planModeActive: true }).policy).toBe("allow");
	});

	/**
	 * The configured `plan` level with no active session keeps the documented precedence.
	 *
	 * This is the boundary of the change and the reason the fix keys on `planModeActive` rather than
	 * on the level. Narrowing it here instead would silently override a per-tool setting for anyone
	 * running `tools.approvalMode = "plan"` as their everyday default.
	 */
	it("leaves a per-tool allow authoritative when no plan-mode session is active", () => {
		expect(resolveApproval(bash, {}, "plan", { bash: "allow" }, { planModeActive: false }).policy).toBe("allow");
		expect(resolveApproval(bash, {}, "plan", { bash: "allow" }).policy).toBe("allow");
	});

	/** The other levels resolve per-tool policy exactly as before. */
	it.each(["ask", "auto-edit", "yolo", "always-ask", "write"] as const)("leaves %s unchanged", mode => {
		expect(resolveApproval(bash, {}, mode, { bash: "allow" }, { planModeActive: true }).policy).toBe("allow");
	});

	/** A tool that overrides carries its own prompt, and the plan cap does not rewrite that path. */
	it("leaves an overriding tool's prompt intact", () => {
		const overriding = { name: "bash", approval: () => ({ tier: "exec" as const, override: true }) };
		const r = resolveApproval(overriding, {}, "plan", { bash: "allow" }, { planModeActive: true });
		expect(r.policy).toBe("prompt");
		expect(r.override).toBe(true);
	});
});
