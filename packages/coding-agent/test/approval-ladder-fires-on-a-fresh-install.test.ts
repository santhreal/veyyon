/**
 * On a fresh install, with nothing configured, the approval ladder actually STOPS a call.
 *
 * THE BUG THIS LOCKS OUT. The shipped default for `tools.approvalMode` was `yolo`. Every rung, every
 * per-tool policy, every tier ceiling, the critical floor and the tool's own `approval(args)` prompt
 * existed and were tested, and none of them ever ran for anyone who had not opened `/settings`: the
 * `yolo` branch of `resolveApprovalInner` returns before any of it. An approval system nobody had
 * configured was an approval system that never fired.
 *
 * WHY NOTHING CAUGHT IT. The two tests that touched the unset case both asserted the default against
 * the constant that defines it:
 *
 *     expect(resolveEffectiveApprovalMode(undefined)).toBe(DEFAULT_APPROVAL_MODE)   // pure matrix
 *     [undefined, DEFAULT_APPROVAL_MODE]                                            // alias grid
 *
 * Set `DEFAULT_APPROVAL_MODE = "yolo"` and both stay green, because the expectation moves with the
 * value it exists to pin. They are still there and still worth having -- they say the two call sites
 * agree -- but they say nothing about whether the ladder does anything, so both now carry a pointer
 * here.
 *
 * WHAT THIS ASSERTS INSTEAD. The unset case is taken from the SCHEMA, the way a fresh install gets
 * it (`getDefault("tools.approvalMode")`), and driven all the way to a resolved decision. Each case
 * pins the exact `policy` a user would experience, so flipping the default to `yolo` -- or to any
 * other rung -- changes a decision here rather than moving an expectation with it.
 */
import { describe, expect, it } from "bun:test";
import { getDefault } from "@veyyon/coding-agent/config/settings-schema";
import type { ApprovalMode, ToolApprovalDecision } from "@veyyon/coding-agent/tools/approval";
import { resolveApproval, resolveEffectiveApprovalMode } from "@veyyon/coding-agent/tools/approval";

/** The rung a fresh install runs on: read from the schema, never from the ladder's own constant. */
function freshInstallMode(): ApprovalMode {
	return resolveEffectiveApprovalMode(getDefault("tools.approvalMode"));
}

/** What {@link resolveApproval} will examine, taken from its own signature rather than restated. */
type ApprovalSubject = Parameters<typeof resolveApproval>[0];

/** A tool whose own `approval(args)` returns `decision`, which is the seam every guard rides on. */
function toolDeciding(decision: ToolApprovalDecision): ApprovalSubject {
	return { name: "bash", approval: () => decision };
}

describe("the approval ladder on a fresh install", () => {
	/**
	 * THE CASE THAT SHIPPED BROKEN. A tool that marks a call `override` is saying "ask about this one
	 * whatever the rung says" -- the working-directory boundary and the credential-use boundary both
	 * arrive here. Under the `yolo` default this returned `allow` and the operator saw no prompt.
	 */
	it("prompts for a call the tool itself flagged, with nothing configured", () => {
		const resolved = resolveApproval(
			toolDeciding({ tier: "exec", override: true, reason: "writes outside the working directory" }),
			{},
			freshInstallMode(),
			{},
		);

		expect(resolved).toEqual({
			policy: "prompt",
			tier: "exec",
			override: true,
			reason: "writes outside the working directory",
		});
	});

	/**
	 * THE FLOOR. A `critical` decision is the `rm -rf /` class. Under the `yolo` default this returned
	 * `allow`, which inverted the whole ordering: the calls a tool considers most dangerous were the
	 * ones most likely to run unasked.
	 */
	it("prompts for a critical call, and keeps the flag the bypass reads", () => {
		const resolved = resolveApproval(
			toolDeciding({ tier: "exec", critical: true, reason: "rm -rf /" }),
			{},
			freshInstallMode(),
			{},
		);

		expect(resolved).toEqual({
			policy: "prompt",
			tier: "exec",
			override: true,
			critical: true,
			reason: "rm -rf /",
		});
	});

	/**
	 * A DENY IS STILL A HARD BLOCK on a fresh install, so an operator who wrote one line of config gets
	 * it honoured without also having to pick a rung.
	 */
	it("denies a tool the operator denied, with no rung configured", () => {
		const resolved = resolveApproval(toolDeciding({ tier: "exec", override: true }), {}, freshInstallMode(), {
			bash: "deny",
		});

		expect(resolved).toEqual({ policy: "deny", tier: "exec", override: true });
	});

	/**
	 * AND THE OTHER HALF, which is what stops this suite from passing by pinning everything to
	 * `prompt`. The default is deliberately not `ask`: an ordinary exec call the tool did not flag runs
	 * without a prompt, because a ladder that stops every call is the failure mode on the other side
	 * and would make the three cases above meaningless.
	 */
	it("still runs an ordinary exec call the tool did not flag", () => {
		const resolved = resolveApproval(toolDeciding({ tier: "exec" }), {}, freshInstallMode(), {});

		expect(resolved).toEqual({ policy: "allow", tier: "exec", override: false });
	});

	/**
	 * THE DEFAULT IS THE SCHEMA'S, not a second literal. `resolveEffectiveApprovalMode(undefined)` is
	 * the path taken when the setting was never written, and it must land on the same rung the schema
	 * hands a fresh config file. Two literals that happen to match is the shape that let the ladder go
	 * dead in the first place, so this compares the two RESOLUTIONS to each other and to a decision.
	 */
	it("resolves the same rung whether the setting is unset or read from the schema", () => {
		expect(resolveEffectiveApprovalMode(undefined)).toBe(freshInstallMode());

		const flagged = toolDeciding({ tier: "exec", override: true });

		expect(resolveApproval(flagged, {}, resolveEffectiveApprovalMode(undefined), {}).policy).toBe("prompt");
	});

	/**
	 * AND AN EXPLICIT `--yolo` IS STILL AN EXPLICIT INSTRUCTION. The point of the fix was never that
	 * yolo is unreachable, it was that nobody arrives there by not choosing. An operator who asks for
	 * it gets it, and even then the critical floor holds.
	 */
	it("honours an explicit --yolo, and still stops at the critical floor", () => {
		const mode = resolveEffectiveApprovalMode(getDefault("tools.approvalMode"), { cliAutoApprove: true });

		expect(mode).toBe("yolo");
		expect(resolveApproval(toolDeciding({ tier: "exec", override: true }), {}, mode, {})).toEqual({
			policy: "allow",
			tier: "exec",
			override: false,
		});
		expect(resolveApproval(toolDeciding({ tier: "exec", critical: true, reason: "rm -rf /" }), {}, mode, {})).toEqual(
			{
				policy: "prompt",
				tier: "exec",
				override: true,
				critical: true,
				reason: "rm -rf /",
			},
		);
	});
});
