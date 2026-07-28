/**
 * Configuring a prompt must never buy LESS protection than configuring nothing.
 *
 * THE BUG. `resolveApprovalInner`'s yolo branch returned the critical floor only when the operator
 * had set no per-tool policy at all:
 *
 *     if (decision.critical && userPolicy === undefined) return { ..., critical: true };
 *     return { policy: userPolicy ?? "allow", tier, override: false };   // critical flag dropped
 *
 * `resolveApproval` then lifts any surviving prompt for the `/yolo` command, sparing only a result
 * carrying `critical: true`. So the two configurations inverted:
 *
 *   tools.approval unset          -> prompt, critical: true  -> bypass spares it   -> operator asked
 *   tools.approval.<tool>=prompt  -> prompt, critical absent -> bypass lifts it    -> runs unasked
 *
 * The operator who went out of their way to demand a confirmation on the most dangerous call in the
 * tool set was the one who silently stopped getting it. That is the exact inversion the critical
 * floor exists to prevent, reintroduced one config key later.
 *
 * WHAT THE FIX IS NOT. It does not make a per-tool setting weaker: `allow` still allows and `deny`
 * still denies, in yolo and under the bypass alike. The flag is metadata about the decision, so it
 * travels with the result whatever the policy is, and only the bypass reads it.
 */
import { describe, expect, it } from "bun:test";
import { resolveApproval } from "@veyyon/coding-agent/tools/approval";

/** A tool whose own decision marks the call critical, the shape `rm -rf ~` produces. */
const criticalTool = {
	name: "bash",
	approval: () => ({ tier: "exec" as const, critical: true, reason: "removes a home directory" }),
};

/** The same tool on a routine call: exec tier, nothing critical about it. */
const routineTool = { name: "bash", approval: () => ({ tier: "exec" as const }) };

describe("a critical decision under the yolo autonomy level", () => {
	/** The floor with nothing configured, which already worked and must keep working. */
	it("prompts when no per-tool policy is set, and marks the result critical", () => {
		const r = resolveApproval(criticalTool, {}, "yolo", {});
		expect(r.policy).toBe("prompt");
		expect(r.critical).toBe(true);
		expect(r.tier).toBe("exec");
		expect(r.reason).toBe("removes a home directory");
	});

	/** THE REGRESSION. A configured `prompt` must carry the flag too, or the bypass eats it. */
	it("keeps the critical flag when the operator explicitly configured a prompt", () => {
		const r = resolveApproval(criticalTool, {}, "yolo", { bash: "prompt" });
		expect(r.policy).toBe("prompt");
		expect(r.critical).toBe(true);
	});

	/** A configured `deny` is a hard block and stays one, flag included. */
	it("keeps a configured deny, and still reports the decision as critical", () => {
		const r = resolveApproval(criticalTool, {}, "yolo", { bash: "deny" });
		expect(r.policy).toBe("deny");
		expect(r.critical).toBe(true);
	});

	/** A configured `allow` is the documented escape hatch and is not narrowed by the fix. */
	it("still honors a configured allow as the escape hatch", () => {
		const r = resolveApproval(criticalTool, {}, "yolo", { bash: "allow" });
		expect(r.policy).toBe("allow");
	});

	/** The flag must not appear on calls the tool did not mark, or the bypass stops working at all. */
	it("does not mark a routine decision critical", () => {
		expect(resolveApproval(routineTool, {}, "yolo", {}).critical).toBeUndefined();
		expect(resolveApproval(routineTool, {}, "yolo", { bash: "prompt" }).critical).toBeUndefined();
	});
});

describe("the /yolo bypass against a critical decision", () => {
	/** The bypass spares the unconfigured floor. Baseline for the comparison below. */
	it("does not lift the prompt when nothing is configured", () => {
		const r = resolveApproval(criticalTool, {}, "yolo", {}, { bypassAllApprovals: true });
		expect(r.policy).toBe("prompt");
	});

	/**
	 * THE PAYOFF, stated as the comparison that was inverted.
	 *
	 * Both configurations must end in a prompt. Before the fix the second returned `allow`, which
	 * meant the more careful operator was the one whose home directory got removed unasked.
	 */
	it("does not lift a prompt the operator configured either", () => {
		const unconfigured = resolveApproval(criticalTool, {}, "yolo", {}, { bypassAllApprovals: true });
		const configured = resolveApproval(criticalTool, {}, "yolo", { bash: "prompt" }, { bypassAllApprovals: true });
		expect(configured.policy).toBe("prompt");
		expect(configured.policy).toBe(unconfigured.policy);
	});

	/** Configuring a prompt is never weaker than configuring nothing, across every mode. */
	it.each(["plan", "ask", "auto-edit", "yolo", "always-ask", "write"] as const)(
		"is at least as strict with a configured prompt as with none, in %s",
		mode => {
			const unconfigured = resolveApproval(criticalTool, {}, mode, {}, { bypassAllApprovals: true });
			const configured = resolveApproval(criticalTool, {}, mode, { bash: "prompt" }, { bypassAllApprovals: true });
			expect(unconfigured.policy).not.toBe("allow");
			expect(configured.policy).not.toBe("allow");
		},
	);

	/** A routine prompt is exactly what the bypass is for, so it must still be lifted. */
	it("still lifts a routine prompt", () => {
		const r = resolveApproval(routineTool, {}, "yolo", { bash: "prompt" }, { bypassAllApprovals: true });
		expect(r.policy).toBe("allow");
	});

	/** A deny is not a prompt, so the bypass never touches it. */
	it("never lifts a deny", () => {
		const r = resolveApproval(criticalTool, {}, "yolo", { bash: "deny" }, { bypassAllApprovals: true });
		expect(r.policy).toBe("deny");
	});
});
