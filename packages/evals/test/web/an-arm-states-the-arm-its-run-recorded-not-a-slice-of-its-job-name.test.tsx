/**
 * WHY THIS SUITE EXISTS.
 *
 * The manager stopped deriving arm identity by slicing a job name at its first hyphen: it reads the
 * coordinates a run recorded, and reads `<experiment>-<arm>` only for an experiment somebody
 * registered. Two dashboard components kept the old slice —
 * `jobName.slice(jobName.indexOf("-") + 1)` — for the arm hint beside a labelled row and for the
 * label field's placeholder. So `sb-v2-base` showed `v2-base` instead of `base`, `deep-swe-baseline`
 * showed `swe-baseline`, and a job name with no hyphen showed the whole name, because `indexOf`
 * returns -1 and the slice then starts at 0.
 *
 * The class this closes: a second, weaker derivation of an identity the server already computes.
 * `ArmSummary` carries `recordedArm` beside the display label, and every component reads that field.
 *
 * What it does not catch: how the server fills `recordedArm`, proven in
 * `test/manager/multi-hyphen-job-names-group-by-recorded-coordinates.test.ts`, and the styling of
 * either row.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ArmEditorRow } from "../../src/web/components/arm-editor-row";
import { ArmRow } from "../../src/web/components/arm-row";
import type { ArmSummary, RunRow } from "../../src/wire";

function armSummary(overrides: Partial<ArmSummary> = {}): ArmSummary {
	const run: RunRow = {
		schemaVersion: 2,
		suite: "terminal-bench@2.0",
		backend: "harbor",
		benchmark: "harbor",
		jobName: "sb-v2-base",
		experiment: "sb-v2",
		arm: "base",
		dataset: "terminal-bench@2.0",
		agent: "veyyon",
		models: "anthropic/claude-sonnet-4-6",
		prewalk: null,
		config: {},
		role: "",
		note: "",
		label: "sonnet, tools off",
		status: "complete",
		pid: null,
		exitCode: 0,
		createdAt: 1,
		finishedAt: 2,
		nTotal: 10,
		done: 10,
		pass: 8,
		fail: 2,
		error: 0,
		running: 0,
		costUsd: 1,
		tokIn: 10,
		tokOut: 10,
		tokCache: null,
		score: 0.8,
		metrics: {},
	};
	return {
		run,
		arm: run.label,
		recordedArm: "base",
		config: "harbor · anthropic/claude-sonnet-4-6",
		passPct: 80,
		costPerTask: 0.1,
		meanTrialMs: 1000,
		projected: null,
		...overrides,
	};
}

function armRowMarkup(arm: ArmSummary): string {
	return renderToStaticMarkup(
		<table>
			<tbody>
				<ArmRow arm={arm} anchor={null} focused={false} onFocus={() => {}} onEdit={() => {}} />
			</tbody>
		</table>,
	);
}

describe("the arm hint beside a labelled row", () => {
	it("states the recorded arm, not the job name after its first hyphen", () => {
		const html = armRowMarkup(armSummary());

		expect(html).toContain(">base<");
		expect(html).not.toContain(">v2-base<");
		// The job name still reaches the reader whole, in the hint's tooltip.
		expect(html).toContain('title="job sb-v2-base"');
	});

	it("is the whole job name when nothing registered an experiment to strip", () => {
		const run: RunRow = { ...armSummary().run, jobName: "standalone_run", experiment: "", arm: "" };
		const html = armRowMarkup(armSummary({ run, recordedArm: "standalone_run" }));

		expect(html).toContain(">standalone_run<");
	});
});

describe("the label field of the arm editor", () => {
	it("offers the recorded arm as its placeholder", () => {
		const html = renderToStaticMarkup(
			<table>
				<tbody>
					<ArmEditorRow
						arm={armSummary()}
						experimentId="sb-v2"
						onSaved={() => {}}
						onCancel={() => {}}
					/>
				</tbody>
			</table>,
		);

		expect(html).toContain('placeholder="base"');
		expect(html).not.toContain('placeholder="v2-base"');
	});
});
