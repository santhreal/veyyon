import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { EvalStatusEvent, EvalToolDetails } from "@veyyon/coding-agent/eval/types";
import { getThemeByName, setThemeInstance, type Theme } from "@veyyon/coding-agent/modes/theme/theme";
import { evalToolRenderer } from "@veyyon/coding-agent/tools/eval-render";

/**
 * Defends the contract that `agent()` calls inside an eval cell surface as a
 * live, Task-tool-style progress tree drawn *below* the cell block — not buried
 * inside the block's collapsed "Status" list, and not deferred to the final
 * result.
 *
 * The block's last row is the last row hanging on its rail. It used to be a
 * closing box border, which is what these arms looked for; a boundary read off a
 * glyph the block no longer draws is a boundary of -1, and every "below the
 * block" assertion then passes on any row anywhere.
 */
describe("eval renderer: agent() progress below the cell block", () => {
	let theme: Theme;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		theme = (await getThemeByName("dark"))!;
		expect(theme).toBeDefined();
		setThemeInstance(theme);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	function render(statusEvents: EvalStatusEvent[], status: "running" | "complete" = "running"): string[] {
		const details: EvalToolDetails = {
			language: "python",
			languages: ["python"],
			cells: [
				{
					index: 0,
					title: "Investigate",
					code: "results = parallel([...])",
					language: "python",
					output: "",
					status,
					statusEvents,
				},
			],
		};
		const component = evalToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: status === "running", spinnerFrame: 0 },
			theme,
		);
		return Bun.stripANSI(component.render(120).join("\n")).split("\n");
	}

	/** Index of the block's last row: the last one hanging on its rail. */
	function blockBottomIndex(lines: string[]): number {
		const rail = theme.symbol("block.rail");
		return lines.findLastIndex(line => line.includes(rail));
	}

	it("draws a running subagent below the block with its current tool and intent", () => {
		const event: EvalStatusEvent = {
			op: "agent",
			id: "0-Scout",
			agent: "task",
			status: "running",
			currentTool: "read",
			currentToolArgs: "config.ts",
			lastIntent: "Reading config",
			taskPreview: "investigate the bug",
			toolCount: 4,
			contextTokens: 5000,
			contextWindow: 200000,
			cost: 0.03,
			durationMs: 800,
			model: "p/model",
		};

		const lines = render([event]);
		const bottom = blockBottomIndex(lines);
		expect(bottom).toBeGreaterThanOrEqual(0);

		const idLine = lines.findIndex(line => line.includes("0-Scout"));
		// The subagent id renders strictly *below* the block's last railed row.
		expect(idLine).toBeGreaterThan(bottom);

		const below = lines.slice(bottom + 1).join("\n");
		const inside = lines.slice(0, bottom + 1).join("\n");
		expect(below).toContain("0-Scout");
		expect(below).toContain("read");
		expect(below).toContain("Reading config");
		// Agent progress is NOT folded into the block's Status section.
		expect(inside).not.toContain("0-Scout");
		expect(inside).not.toContain("Reading config");
	});

	it("keeps full stats on a completed subagent below the block", () => {
		const event: EvalStatusEvent = {
			op: "agent",
			id: "0-Scout",
			agent: "task",
			status: "completed",
			toolCount: 7,
			contextTokens: 8000,
			contextWindow: 200000,
			cost: 0.06,
			durationMs: 1500,
			model: "p/model",
		};

		const lines = render([event], "complete");
		const bottom = blockBottomIndex(lines);
		const idLine = lines.findIndex(line => line.includes("0-Scout"));
		expect(idLine).toBeGreaterThan(bottom);

		const below = lines.slice(bottom + 1).join("\n");
		// Cost stat survives the completed snapshot.
		expect(below).toContain("$0.06");
	});

	it("renders one line per subagent for a parallel fan-out", () => {
		const events: EvalStatusEvent[] = [
			{ op: "agent", id: "0-Alpha", agent: "task", status: "running", lastIntent: "scanning" },
			{ op: "agent", id: "1-Beta", agent: "task", status: "completed", toolCount: 3, durationMs: 900 },
			{ op: "agent", id: "2-Gamma", agent: "task", status: "running", currentTool: "search" },
		];

		const lines = render(events);
		const below = lines.slice(blockBottomIndex(lines) + 1).join("\n");
		expect(below).toContain("0-Alpha");
		expect(below).toContain("1-Beta");
		expect(below).toContain("2-Gamma");
	});

	it("still folds non-agent status events into the block's Status section", () => {
		const events: EvalStatusEvent[] = [
			{ op: "read", path: "/tmp/file.ts", chars: 1200 },
			{ op: "agent", id: "0-Scout", agent: "task", status: "running", lastIntent: "thinking" },
		];

		const lines = render(events);
		const bottom = blockBottomIndex(lines);
		const inside = lines.slice(0, bottom + 1).join("\n");
		const below = lines.slice(bottom + 1).join("\n");

		// Discrete ops stay inside the block; agent progress renders below it.
		expect(inside).toContain("read");
		expect(inside).toContain("file.ts");
		expect(inside).not.toContain("0-Scout");
		expect(below).toContain("0-Scout");
	});
});
