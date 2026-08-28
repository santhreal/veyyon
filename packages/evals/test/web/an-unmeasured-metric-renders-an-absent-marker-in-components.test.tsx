/**
 * WHY:
 * When trials report no cost, duration or ETA (e.g. unmeasured or in-flight trials),
 * dashboard components must render the canonical absent marker ("—") rather than
 * coercing null to zero ($0.000, 0.0m, ~0m) which falsely claims the run was free or instantaneous.
 *
 * This suite verifies the contract directly through the UI components that render these values.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ArmRow } from "../../dashboard/components/arm-row";
import { Delta, pickReferenceArm } from "../../dashboard/components/delta";
import type { ArmSummary, RunRow } from "../../engine/store-shapes";

function makeRunRow(overrides: Partial<RunRow> = {}): RunRow {
	return {
		schemaVersion: 1,
		suite: "test-suite",
		backend: "in-process",
		benchmark: "harbor",
		jobName: "exp1-arm_a",
		experiment: "exp1",
		arm: "arm_a",
		dataset: "dataset1",
		agent: "agent1",
		models: "model1",
		prewalk: null,
		config: {},
		role: "baseline",
		note: "baseline arm",
		label: "Arm A",
		status: "complete",
		pid: null,
		exitCode: 0,
		createdAt: 1000,
		finishedAt: 2000,
		nTotal: 10,
		done: 10,
		pass: 8,
		fail: 2,
		error: 0,
		running: 0,
		costUsd: null,
		tokIn: 100,
		tokOut: 50,
		tokCache: null,
		score: 0.8,
		metrics: {},
		...overrides,
	};
}

function makeArmSummary(overrides: Partial<ArmSummary> = {}): ArmSummary {
	return {
		run: makeRunRow(),
		arm: "arm_a",
		recordedArm: "arm_a",
		config: "model1",
		passPct: 80,
		costPerTask: null,
		meanTrialMs: null,
		projected: null,
		...overrides,
	};
}

describe("Dashboard components render absent markers for unmeasured metrics", () => {
	it("renders absent markers in ArmRow when spend, duration, and ETA are null", () => {
		const unmeasuredArm = makeArmSummary({
			costPerTask: null,
			meanTrialMs: null,
			projected: null,
		});

		const html = renderToStaticMarkup(
			<table>
				<tbody>
					<ArmRow arm={unmeasuredArm} anchor={null} focused={false} onFocus={() => {}} onEdit={() => {}} />
				</tbody>
			</table>,
		);

		// Must render absent marker "—"
		expect(html).toContain("—");
		// Must not render zero representations
		expect(html).not.toContain("$0.00");
		expect(html).not.toContain("$0.000");
		expect(html).not.toContain("0.0m");
		expect(html).not.toContain("~0m");
	});

	it("renders absent markers in ArmRow with running arm having unmeasured projections", () => {
		const runningArm = makeArmSummary({
			run: makeRunRow({ status: "running", done: 2, running: 1 }),
			costPerTask: null,
			meanTrialMs: null,
			projected: {
				etaMs: null,
				passPct: 50,
				costPerTask: null,
				totalCostUsd: null,
				meanTrialMs: 0,
			},
		});

		const html = renderToStaticMarkup(
			<table>
				<tbody>
					<ArmRow arm={runningArm} anchor={null} focused={false} onFocus={() => {}} onEdit={() => {}} />
				</tbody>
			</table>,
		);

		expect(html).toContain("—");
		expect(html).not.toContain("$0.00");
		expect(html).not.toContain("$0.000");
	});

	it("renders absent markers in Delta component when reference or target values are null", () => {
		const nullValHtml = renderToStaticMarkup(
			<Delta value={null} reference={10} mode="relative" higherBetter={false} />,
		);
		expect(nullValHtml).toBe("");

		const nullRefHtml = renderToStaticMarkup(
			<Delta value={10} reference={null} mode="relative" higherBetter={false} />,
		);
		expect(nullRefHtml).toBe("");
	});

	it("picks reference arm honestly ignoring baseline arms with null passPct", () => {
		const armWithoutPass = makeArmSummary({
			run: makeRunRow({ role: "baseline" }),
			passPct: null,
			costPerTask: 1.5,
		});
		const armWithPass = makeArmSummary({
			run: makeRunRow({ role: "baseline", label: "Valid Baseline" }),
			passPct: 75,
			costPerTask: 2.0,
		});

		const ref = pickReferenceArm([armWithoutPass, armWithPass]);
		expect(ref).not.toBeNull();
		expect(ref?.run.label).toBe("Valid Baseline");
	});
});
