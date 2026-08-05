/**
 * The rung an operator gets when they have configured nothing.
 *
 * WHY THIS SUITE EXISTS. The unset default used to be decided in four places at
 * once: the `tools.approvalMode` schema entry, `normalizeApprovalMode`,
 * `resolveEffectiveApprovalMode`, and the tool wrapper's read of a missing
 * `Settings`. Each spelled its own literal, so "what happens with no config"
 * depended on which path ran first, and the answer drifted between them.
 * `DEFAULT_APPROVAL_MODE` is now the only literal, and these cases pin the
 * observable end of that: a loader with nothing in it, run through the real
 * resolver, lands on `auto` and reports `default` as the layer that supplied it.
 *
 * The second half is the regression risk of moving a default at all. Changing
 * which rung is chosen when unset must not move any rung that WAS chosen, so
 * every accepted spelling is asserted here, including the three legacy names
 * that stored configs still carry.
 */
import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	normalizeApprovalMode,
	requiresApproval,
	resolveEffectiveApprovalMode,
} from "@veyyon/coding-agent/tools/approval";
import { DEFAULT_APPROVAL_MODE } from "@veyyon/coding-agent/tools/approval-modes";

describe("the unset tools.approvalMode default", () => {
	/**
	 * The contract, read the way the tool wrapper reads it: load settings with
	 * nothing configured, hand the value to the resolver, and see which rung
	 * comes back. Asserting the schema literal instead would pass even if the
	 * resolver overrode it, which is exactly the defect this replaced.
	 */
	it("resolves to auto through an empty loader and the real resolver", () => {
		const settings = Settings.isolated({});

		const configured = settings.get("tools.approvalMode");

		expect(resolveEffectiveApprovalMode(configured)).toBe("auto");
		expect(normalizeApprovalMode(configured)).toBe("auto");
	});

	/**
	 * `getSource` is what `/permissions` prints as the origin, and `default` has
	 * to stay distinguishable from a saved value or the report cannot tell an
	 * operator whether to edit `/settings` or drop an override.
	 */
	it("reports default as the supplying layer when nothing is configured", () => {
		const settings = Settings.isolated({});

		expect(settings.isConfigured("tools.approvalMode")).toBe(false);
		expect(settings.getSource("tools.approvalMode")).toBe("default");
	});

	/**
	 * The absent-caller path. A wrapper invoked without a `Settings` at all has
	 * no operator intent to honour, and it must land on the same rung a fresh
	 * install does rather than on a fallback of its own.
	 *
	 * Asserted against the LITERAL "auto", not `DEFAULT_APPROVAL_MODE`. Comparing
	 * against the constant made the expectation follow the value it exists to pin:
	 * setting `DEFAULT_APPROVAL_MODE` to "yolo" left both lines green while every
	 * caller that omits a `Settings` silently moved to the rung with no guards. The
	 * two cases above already use the literal for exactly this reason; these were the
	 * last two in the file that did not.
	 */
	it("gives an absent configured value the same rung as an empty loader", () => {
		expect(resolveEffectiveApprovalMode(undefined)).toBe("auto");
		expect(normalizeApprovalMode(undefined)).toBe("auto");
		// And the shipped constant really is that rung, so the two paths cannot drift
		// apart silently: this is the ONE place the constant is read, as a subject.
		expect(DEFAULT_APPROVAL_MODE).toBe("auto");
	});

	/**
	 * The last inch of the installed-binary regression, pinned at the decision
	 * the wrapper actually computes. The schema default moved to `auto` while
	 * the normalizer had no mapping for it, so a fresh install failed closed to
	 * `ask` and EVERY tier prompted. The resolver cases above were green the
	 * whole time; what nobody asserted is that the resolved default APPROVES an
	 * ordinary exec-tier call rather than merely being named "auto".
	 */
	it("approves an ordinary exec-tier call on the resolved default", () => {
		const settings = Settings.isolated({});
		const mode = resolveEffectiveApprovalMode(settings.get("tools.approvalMode"));
		const execTool = { name: "bash", approval: "exec" as const };

		expect(requiresApproval(execTool, {}, mode, {}).required).toBe(false);
	});
});

describe("an explicitly configured rung outranks the default", () => {
	const configured: Array<[string, string]> = [
		["ask", "ask"],
		["ask-command", "ask-command"],
		["auto", "auto"],
		["yolo", "yolo"],
		["plan", "plan"],
		// Legacy spellings still found in stored configs.
		["always-ask", "ask"],
		["write", "ask-command"],
		["auto-edit", "ask-command"],
	];

	for (const [stored, rung] of configured) {
		it(`keeps ${stored} on the ${rung} rung`, () => {
			const settings = Settings.isolated({ "tools.approvalMode": stored });

			const value = settings.get("tools.approvalMode");

			expect(value).toBe<string>(stored);
			expect(normalizeApprovalMode(value)).toBe<string>(rung);
			expect(resolveEffectiveApprovalMode(value)).toBe<string>(stored);
			expect(settings.getSource("tools.approvalMode")).not.toBe("default");
		});
	}

	/**
	 * A typo is not an unset value. It fails closed to `ask`, never to the
	 * default and never up the ladder, so raising the default cannot quietly
	 * promote a misspelled config.
	 */
	it("fails a typo closed to ask rather than to the default", () => {
		expect(normalizeApprovalMode("askk")).toBe("ask");
		expect(normalizeApprovalMode("")).toBe("ask");
		expect(DEFAULT_APPROVAL_MODE).not.toBe("ask");
	});

	/**
	 * The same fail-closed at the decision the wrapper computes: a typo'd stored
	 * value must end at a rung that PROMPTS an ordinary exec-tier call, never at
	 * one that runs it.
	 */
	it("prompts an ordinary exec-tier call when the stored value is a typo", () => {
		const execTool = { name: "bash", approval: "exec" as const };

		expect(requiresApproval(execTool, {}, resolveEffectiveApprovalMode("askk"), {}).required).toBe(true);
	});
});
