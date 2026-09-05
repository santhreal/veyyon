/**
 * WHY: the setup form lists a goal, a preset, three counts, a switch and a
 * model list under labels of different lengths. Every value must start at one
 * column whatever the setting holds ("2 arms", "4 arms", "auto", a long goal,
 * a goal that arrived with a tab in it), and the column must exist on the
 * card the reader sees, at every width the card reaches, not only in the
 * form's own paint: the launcher and the dashboard's setup view both inset
 * the form, and a card that lost the column would pass a form-only check.
 *
 * The class this closes is a value column that twitches as settings change,
 * a tab opening a hole through it, and a card that paints the form at a
 * different inset from the one its pointer routing assumes.
 *
 * What it does not catch: colour, or how a terminal kerns the glyphs.
 */
import { describe, expect, it } from "bun:test";
import { FIELD_LABELS, LoopConsoleModel } from "@veyyon/coding-agent/autoresearch/console";
import { LAUNCHER_WIDTH, LauncherComponent } from "@veyyon/coding-agent/autoresearch/launcher";
import { AutoresearchScreenComponent } from "@veyyon/coding-agent/autoresearch/screen";
import { createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import { MAX_ATTEMPTS, MAX_BREADTH, MIN_ATTEMPTS, MIN_SWARM_BREADTH } from "@veyyon/coding-agent/autoresearch/swarm";
import { stripAnsi } from "@veyyon/utils";
import { driveConsole, NO_SESSION, recordingHost } from "./helpers/autoswarm-console";
import { useTruecolorTheme } from "./helpers/theme-assertions";

/** Labelled rows only: `<marker><label><gap><value>`, the marker two cells wide. */
const LABELLED = new RegExp(`^(?:▸ |  )(${Object.values(FIELD_LABELS).join("|")}|Save as) `);

/** The column each labelled row's value starts at. */
function valueColumns(lines: readonly string[]): number[] {
	const columns: number[] = [];
	for (const line of lines) {
		const match = LABELLED.exec(line);
		if (!match) continue;
		// Past the label, the padding to the column is spaces; the value is the first non-space.
		const rest = line.slice(match[0].length);
		const lead = rest.length - rest.trimStart().length;
		columns.push(match[0].length + lead);
	}
	return columns;
}

describe("the console rows keep their value column", () => {
	useTruecolorTheme("dark");

	it("starts every field value at one column across all reachable settings", () => {
		let column: number | null = null;
		for (let breadth = MIN_SWARM_BREADTH; breadth <= MAX_BREADTH; breadth += 1) {
			for (let attempts = MIN_ATTEMPTS; attempts <= MAX_ATTEMPTS; attempts += 1) {
				for (const certify of [true, false]) {
					for (const iterations of [null, 1, 999]) {
						const { frame } = driveConsole({
							goal: "optimize throughput",
							breadth,
							attempts,
							certify,
							maxIterations: iterations,
							armModels: ["sonnet", "gpt-5"],
						});
						const columns = valueColumns(frame());
						// Goal, Preset, Breadth, Models, Attempts, Certify, Iterations, Save as.
						expect(columns).toHaveLength(8);
						column ??= columns[0]!;
						expect(columns).toEqual(Array(8).fill(column));
					}
				}
			}
		}
		// Two cells of marker, the widest label, two cells of gap.
		expect(column).toBe(2 + "Iterations".length + 2);
	});

	it("keeps the column for special values: arms, auto, an empty goal, and a tab in the goal", () => {
		const rowOf = (lines: readonly string[], label: string): string =>
			lines.find(line => LABELLED.test(line) && line.includes(label)) ?? "";
		const valueAt = (lines: readonly string[], label: string): string => rowOf(lines, label).slice(14).trim();

		const minSwarm = driveConsole({ breadth: MIN_SWARM_BREADTH }).frame();
		expect(valueAt(minSwarm, "Breadth")).toMatch(new RegExp(`^${MIN_SWARM_BREADTH} arms ▸`));
		expect(valueAt(driveConsole({ breadth: 4 }).frame(), "Breadth")).toMatch(/^◂ 4 arms ▸/);
		expect(valueAt(driveConsole({ maxIterations: null }).frame(), "Iterations")).toMatch(/^auto ▸/);
		expect(valueAt(driveConsole({ maxIterations: 42 }).frame(), "Iterations")).toMatch(/^◂ 42 ▸/);

		// An empty goal with the ring shows the caret and the prompt in the column.
		const empty = driveConsole({ goal: "" });
		empty.form.focus("goal");
		expect(valueAt(empty.frame(), "Goal")).toBe("what to optimize");
		empty.form.focus("breadth");
		expect(valueAt(empty.frame(), "Goal")).toBe("what to optimize");

		// A goal with tabs is flattened to one line, one space per run, so no
		// tab opens a hole through the column.
		const tabbed = driveConsole({ goal: "make\tfast\t\tnow" });
		expect(valueAt(tabbed.frame(), "Goal")).toBe("make fast now");
		expect(valueColumns(tabbed.frame())).toEqual(Array(8).fill(14));
	});

	it("prints the column on the launcher and on the dashboard's setup view, at every width the card reaches", () => {
		const setup = { goal: "make\tit", breadth: 4, armModels: ["opus"] };
		for (const width of [60, 100, 140]) {
			const model = new LoopConsoleModel(
				{
					goal: setup.goal,
					breadth: setup.breadth,
					attempts: 1,
					certify: true,
					armModels: setup.armModels,
					maxIterations: null,
				},
				recordingHost(),
			);
			const launcher = new LauncherComponent({ model, close: () => {}, requestRender: () => {}, rows: () => 30 });
			// The launcher is painted at its own width: the card, not the terminal, is the surface.
			const card = launcher.render(Math.min(width, LAUNCHER_WIDTH)).map(line => stripAnsi(line));
			// Inside the border and its inset, the form's own column.
			const inner = card.map(line => line.slice(2));
			expect(valueColumns(inner)).toEqual(Array(8).fill(14));
			expect(inner.find(line => line.includes("Goal"))?.slice(14)).toMatch(/^make it +│$/);
			expect(inner.find(line => line.includes("Breadth"))?.slice(14)).toMatch(/^◂ 4 arms ▸/);

			const screen = new AutoresearchScreenComponent({
				runtime: createSessionRuntime(),
				model: new LoopConsoleModel(
					{
						goal: setup.goal,
						breadth: setup.breadth,
						attempts: 1,
						certify: true,
						armModels: setup.armModels,
						maxIterations: null,
					},
					recordingHost({ situation: () => ({ ...NO_SESSION, session: { name: "s", branch: "b", runs: 1 } }) }),
				),
				close: () => {},
				requestRender: () => {},
				rows: () => 30,
			});
			screen.handleInput("e");
			const view = screen.render(width).map(line => stripAnsi(line).slice(2));
			expect(valueColumns(view)).toEqual(Array(8).fill(14));
			expect(view.find(line => line.includes("Goal"))?.slice(14)).toMatch(/^make it +│$/);
		}
	});
});
