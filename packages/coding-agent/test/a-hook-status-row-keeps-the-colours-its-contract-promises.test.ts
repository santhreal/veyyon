/**
 * WHY: `ctx.ui.setStatus` documents that the text "can include ANSI escape
 * codes for styling" and points a hook at `theme.fg` to paint it. The footer
 * row that shows those statuses ran every one through `sanitizeStatusText`,
 * which strips SGR with everything else, so a styled status arrived grey. The
 * report was the autoresearch status row: `2 kept` in success green, a flag
 * count in warning, the best metric in the tool colour, all painted by
 * `renderStatusRow` and all lost between `setStatus` and the screen.
 *
 * The class: a surface whose contract admits styled text and whose sanitizer
 * treats style as an escape to strip. It is closed at the sanitizer, which now
 * has a styled variant that keeps SGR and only SGR, and this suite drives the
 * production path end to end: the real `StatusLineComponent`, fed by the real
 * `renderStatusRow`, asserting that the same colour bytes the row was built
 * with reach the rendered line, and that a cursor move or hyperlink in a hook's
 * status still does not.
 *
 * Not caught: a hook that styles with an OSC hyperlink, which the row drops by
 * design, and the width the footer truncates at.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderStatusRow } from "@veyyon/coding-agent/autoresearch/dashboard";
import { createExperimentState, createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import type { AutoresearchRuntime, ExperimentResult } from "@veyyon/coding-agent/autoresearch/types";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/terminal/components/status-line/component";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { removeSyncWithRetries, setProjectDir, stripAnsi } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";
import { makeStatusLineSession } from "./helpers/status-line-session";
import { useTruecolorTheme } from "./helpers/theme-assertions";

let settingsState: SettingsTestState | undefined;
let projectDir = "";

beforeEach(async () => {
	settingsState = beginSettingsTest();
	projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-hook-status-colour-"));
	setProjectDir(projectDir);
	await Settings.init({ inMemory: true, cwd: projectDir });
});

afterEach(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	if (projectDir) removeSyncWithRetries(projectDir);
	projectDir = "";
});

function result(overrides: Partial<ExperimentResult>): ExperimentResult {
	return {
		runNumber: 1,
		commit: "abcdef1234567890",
		metric: 100,
		measuredPrimary: 100,
		metrics: {},
		status: "keep",
		description: "shortened the hot loop",
		timestamp: 0,
		segment: 0,
		confidence: null,
		modifiedPaths: ["src/a.ts"],
		scopeDeviations: [],
		justification: null,
		flagged: false,
		flaggedReason: null,
		arm: null,
		certifiedBy: null,
		model: null,
		...overrides,
	};
}

/** A swarm with kept runs, a flagged run and a best: every painted segment present. */
function paintedRuntime(): AutoresearchRuntime {
	const runtime = createSessionRuntime();
	runtime.autoresearchMode = true;
	runtime.state = createExperimentState();
	runtime.state.name = "startup-latency";
	runtime.state.metricName = "duration";
	runtime.state.metricUnit = "ms";
	runtime.state.breadth = 4;
	runtime.state.confidence = 2.5;
	runtime.state.results = [
		result({ runNumber: 1, metric: 120 }),
		result({ runNumber: 2, metric: 90 }),
		result({ runNumber: 3, metric: 80, flagged: true, flaggedReason: "measured on a dirty tree" }),
	];
	return runtime;
}

function footer(): StatusLineComponent {
	const component = new StatusLineComponent(
		makeStatusLineSession({
			modelId: "test-model",
			modelName: "Test Model",
			contextWindow: 100_000,
			contextUsage: undefined,
			sessionName: "Hook Status",
		}),
	);
	component.updateSettings({ preset: "default", showHookStatus: true });
	return component;
}

describe("a hook status row keeps the colours its contract promises", () => {
	useTruecolorTheme("dark");

	it("shows the autoresearch status row with the bytes it was painted with", () => {
		const row = renderStatusRow(paintedRuntime(), 200);
		// The row under test really is painted: with colour stripped it still
		// says what it says, and with colour kept it differs from that.
		expect(row).not.toBe(stripAnsi(row));
		const component = footer();
		component.setHookStatus("autoresearch", row);
		const [line] = component.render(200);
		expect(line).toBe(row);
		expect(line).toContain(theme.fg("success", "3 kept"));
		expect(line).toContain(theme.fg("warning", "1 flagged"));
	});

	it("still drops a hook's cursor moves, hyperlinks and graphics", () => {
		const component = footer();
		component.setHookStatus(
			"rogue",
			`\x1b[2K\x1b[1A${theme.fg("success", "ok")}\x1b]8;;https://example.com\x07 link\x1b]8;;\x07\x1b_Ga=T;PAYLOAD\x1b\\`,
		);
		const [line] = component.render(80);
		expect(line).toBe(`${theme.fg("success", "ok")} link`);
	});
});
