/**
 * A critical decision still prompts in yolo, and the `/yolo` bypass cannot lift
 * it.
 *
 * WHY THIS EXISTS. `resolveApprovalInner` returned `userPolicy ?? "allow"` for
 * yolo BEFORE it ever consulted `decision.override`, so there was no command a
 * yolo session refused. That inverts the severity ordering: the calls a tool
 * considers most dangerous are the ones most likely to be run in the mode that
 * skips the check, and every published home-directory wipe happened in exactly
 * that configuration. `override` is still the ordinary strength, which yolo is
 * entitled to ignore; `critical` is the floor beneath it.
 *
 * The escape hatch is deliberate and tested here too. A user who sets
 * `tools.approval.bash` to `allow` has said so explicitly and gets what they
 * asked for. What they no longer get is that behaviour by default.
 */

import { describe, expect, it } from "bun:test";

import { requiresApproval, resolveApproval } from "../src/tools/approval";

/** A tool whose every call is ordinary. */
const ordinary = { name: "bash", approval: "exec" as const };

/** A tool that force-prompts, at the strength yolo may ignore. */
const overriding = {
	name: "bash",
	approval: { tier: "exec" as const, override: true, reason: "Critical pattern detected" },
};

/** A tool that force-prompts with a floor under it. */
const critical = {
	name: "bash",
	approval: { tier: "exec" as const, critical: true, reason: "rm would recursively remove the home directory itself" },
};

describe("the floor under yolo", () => {
	/** THE regression. Before the fix this returned `allow`. */
	it("prompts for a critical call in yolo", () => {
		const resolved = resolveApproval(critical, {}, "yolo", {});

		expect(resolved.policy).toBe("prompt");
		expect(resolved.critical).toBe(true);
	});

	/**
	 * The prompt carries the tool's own sentence, because "critical pattern
	 * detected" tells nobody which part of a long command line was the problem.
	 */
	it("carries the reason into the prompt", () => {
		const resolved = resolveApproval(critical, {}, "yolo", {});

		expect(resolved.reason).toBe("rm would recursively remove the home directory itself");
	});

	/**
	 * The ordinary override strength is unchanged: yolo still ignores it. Pinned
	 * so the floor cannot quietly widen into "yolo prompts for everything",
	 * which would make yolo useless and get it worked around.
	 */
	it("still allows an ordinary override in yolo", () => {
		expect(resolveApproval(overriding, {}, "yolo", {}).policy).toBe("allow");
		expect(resolveApproval(ordinary, {}, "yolo", {}).policy).toBe("allow");
	});
});

describe("the /yolo bypass against the floor", () => {
	/**
	 * The bypass turns a prompt into an allow as its last step. A critical
	 * prompt is a floor rather than friction, so the bypass steps over it.
	 */
	it("does not lift a critical prompt", () => {
		const resolved = resolveApproval(critical, {}, "ask", {}, { bypassAllApprovals: true });

		expect(resolved.policy).toBe("prompt");
	});

	/** And it still lifts an ordinary one, which is what it is for. */
	it("still lifts an ordinary prompt", () => {
		const resolved = resolveApproval(overriding, {}, "ask", {}, { bypassAllApprovals: true });

		expect(resolved.policy).toBe("allow");
	});

	/** Both mechanisms at once, which is the configuration an incident runs in. */
	it("does not lift a critical prompt in yolo either", () => {
		const resolved = resolveApproval(critical, {}, "yolo", {}, { bypassAllApprovals: true });

		expect(resolved.policy).toBe("prompt");
	});
});

describe("an explicit setting is still authoritative", () => {
	/**
	 * The escape hatch. A user who writes `tools.approval.bash = "allow"` has
	 * made the decision knowingly, and the guard is not entitled to overrule a
	 * direct instruction. What changed is the DEFAULT, which is where every
	 * incident happened.
	 */
	it("an explicit allow beats the floor", () => {
		expect(resolveApproval(critical, {}, "yolo", { bash: "allow" }).policy).toBe("allow");
	});

	/** Deny is stronger than the floor in the other direction, as it always was. */
	it("an explicit deny still denies", () => {
		expect(resolveApproval(critical, {}, "yolo", { bash: "deny" }).policy).toBe("deny");
	});

	/**
	 * An explicit `prompt` gets a prompt, which is what the floor produces
	 * anyway. Stated so the interaction is pinned rather than inferred.
	 */
	it("an explicit prompt prompts", () => {
		expect(resolveApproval(critical, {}, "yolo", { bash: "prompt" }).policy).toBe("prompt");
	});
});

describe("critical implies override", () => {
	/**
	 * Requiring both flags at every call site is a way to eventually forget one,
	 * so `critical` sets `override` as well. In the non-yolo modes that means a
	 * critical call prompts over a per-tool allow, exactly as an override does.
	 */
	it("beats a per-tool allow outside yolo", () => {
		const resolved = resolveApproval(critical, {}, "auto-edit", { bash: "allow" });

		expect(resolved.policy).toBe("prompt");
		expect(resolved.override).toBe(true);
	});

	/** And the flag is reported on the result rather than only acted upon. */
	it("reports itself on the resolved approval", () => {
		expect(resolveApproval(critical, {}, "yolo", {}).critical).toBe(true);
		expect(resolveApproval(overriding, {}, "ask", {}).critical).toBeUndefined();
	});
});

describe("the function the tool wrapper actually calls", () => {
	/**
	 * `resolveApproval` is the rule; `requiresApproval` is what
	 * `ToolWrapper.execute` calls, unconditionally, before any yolo
	 * short-circuit. Asserting the floor only on the rule would leave open the
	 * possibility that nothing downstream asks the question.
	 *
	 * `tools.approvalMode` no longer defaults to `yolo`; the shipped default is
	 * `DEFAULT_APPROVAL_MODE`, which is not that rung, so nobody lands on yolo by
	 * accident. That does not make the floor an edge case, it makes it narrower
	 * and more load-bearing: an operator on `yolo` chose it deliberately, has
	 * said they want no prompts, and is exactly the person a `rm -rf ~/` reaches
	 * unchallenged. The floor is the one thing that still stops them.
	 */
	it("requires approval for a critical call in yolo", () => {
		const check = requiresApproval(critical, {}, "yolo", {});

		expect(check.required).toBe(true);
		expect(check.reason).toBe("rm would recursively remove the home directory itself");
	});

	/** And still does not stop ordinary work in the same mode. */
	it("requires nothing for an ordinary call in yolo", () => {
		expect(requiresApproval(ordinary, {}, "yolo", {}).required).toBe(false);
	});

	/** The bypass does not turn the floor into a silent allow here either. */
	it("still requires approval under the /yolo bypass", () => {
		const check = requiresApproval(critical, {}, "yolo", {}, { bypassAllApprovals: true });

		expect(check.required).toBe(true);
	});

	/**
	 * A `deny` still throws rather than prompting, because a deny is a hard
	 * block and the floor must not soften it into a question.
	 */
	it("still throws for an explicit deny", () => {
		expect(() => requiresApproval(critical, {}, "yolo", { bash: "deny" })).toThrow();
	});
});

describe("the bash tool's own decisions", () => {
	/**
	 * End to end through the real tool rather than a stand-in, because the
	 * finding was that the two halves disagreed about which strength to use.
	 * A home-directory delete must reach `prompt` in yolo from the actual
	 * `BashTool.approval`.
	 */
	it("marks a home-directory delete critical", async () => {
		const { bashApprovalDecision } = await import("../src/tools/bash");
		const tool = { name: "bash", approval: bashApprovalDecision };

		const resolved = resolveApproval(tool, { command: "rm -rf ~/" }, "yolo", {});

		expect(resolved.policy).toBe("prompt");
		expect(resolved.reason).toContain("recursively remove");
	});

	/** And leaves ordinary work alone in the same mode. */
	it("leaves an ordinary command allowed in yolo", async () => {
		const { bashApprovalDecision } = await import("../src/tools/bash");
		const tool = { name: "bash", approval: bashApprovalDecision };

		expect(resolveApproval(tool, { command: "rm -rf node_modules" }, "yolo", {}).policy).toBe("allow");
		expect(resolveApproval(tool, { command: "bun test" }, "yolo", {}).policy).toBe("allow");
	});

	/**
	 * THE WIRING, through a real `BashTool` rather than the exported function.
	 * `tools.protectedPaths` is only worth having if the value an operator
	 * writes actually reaches the decision, and the two are joined by an arrow
	 * reading `this.session` at call time. A test that only exercised
	 * `bashApprovalDecision(args, paths)` would pass with the setting unread.
	 */
	it("reads tools.protectedPaths off the session", async () => {
		const { BashTool } = await import("../src/tools/bash");
		const { makeToolSession } = await import("./helpers/tool-session");
		const session = makeToolSession({
			settings: { get: (path: string) => (path === "tools.protectedPaths" ? ["/mnt/photos"] : undefined) },
		});
		const bash = new BashTool(session);

		const decision = bash.approval({ command: "rm -rf /mnt/photos" });

		expect(typeof decision).toBe("object");
		expect((decision as { reason?: string }).reason).toContain("tools.protectedPaths");
	});

	/** With no such setting the same command is ordinary work. */
	it("leaves the same command alone when nothing is configured", async () => {
		const { BashTool } = await import("../src/tools/bash");
		const { makeToolSession } = await import("./helpers/tool-session");
		const bash = new BashTool(makeToolSession());

		expect(bash.approval({ command: "rm -rf /mnt/photos" })).toBe("exec");
	});

	/**
	 * And the built-in floor does not depend on the setting existing, which is
	 * the property that makes an unreadable or empty configuration harmless.
	 */
	it("still refuses the home directory with no setting at all", async () => {
		const { BashTool } = await import("../src/tools/bash");
		const { makeToolSession } = await import("./helpers/tool-session");
		const bash = new BashTool(makeToolSession());

		const decision = bash.approval({ command: "rm -rf ~/" });

		expect((decision as { critical?: boolean }).critical).toBe(true);
	});
});
