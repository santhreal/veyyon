/**
 * resolveEffectiveApprovalMode full cartesian of config × flags.
 * Why: cli yolo > plan cap > configured; every cell must be exact.
 */
import { describe, expect, it } from "bun:test";
import { resolveEffectiveApprovalMode } from "../src/tools/approval";

describe("resolveEffectiveApprovalMode cartesian grid", () => {
	const configs = [undefined, "yolo", "ask", "plan", "auto-edit", "write", "always-ask"] as const;

	for (const c of configs) {
		for (const cli of [false, true]) {
			for (const plan of [false, true]) {
				it(`c=${String(c)} cli=${cli} plan=${plan}`, () => {
					const got = resolveEffectiveApprovalMode(c, {
						cliAutoApprove: cli,
						planModeActive: plan,
					});
					// resolveEffectiveApprovalMode returns the narrow AutonomyLevel union;
					// the expected fallback is a plain string, so widen the matcher.
					if (cli) expect(got).toBe("yolo");
					else if (plan) expect(got).toBe("plan");
					else expect(got).toBe<string>(c ?? "yolo");
				});
			}
		}
	}
});
