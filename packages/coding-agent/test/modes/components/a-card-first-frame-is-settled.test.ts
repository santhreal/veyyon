/**
 * WHY THIS SUITE EXISTS.
 *
 * Modal overlays and card panels previously executed entrance animations:
 * a 260ms unfold, staggered row cascades, and a 520ms specular sweep highlight.
 * This delayed readability and introduced visual latency when opening dialogs,
 * pickers, settings, and dashboards.
 *
 * THE CLASS, NOT THE INCIDENT.
 * Every overlay in the product must be instantly readable on its first paint:
 * frame 0 (the first rendered frame) must be byte-identical to the settled frame
 * (after arbitrary clock time). There are no collapsed entrance states, no row
 * cascades, and no specular sweeps on card surfaces.
 *
 * FAIL BY DEFAULT ON NEW MEMBERS.
 * Every overlay component that uses `renderModalShell` or functions as a modal
 * overlay is constructed in `overlay-specs.ts`, which every suite that sweeps all
 * of them reads. `OVERLAY_NAMES` below is the roll-call: a new overlay class is
 * red here until it is both constructed there and named here, which is also what
 * puts it into the sweep that no rule inside a card is painted in the accent.
 * The sweep asserts that the unconstructable set is empty.
 *
 * WHAT IT DOES NOT CATCH.
 * Steady-state motion (rail light travel, spinners, pointer hover bands) is
 * governed by other suites and remains active when motion is enabled. What the
 * material of a note or a band LOOKS like is taste, judged in the demo scenes.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AnsiPolicy } from "@veyyon/tui";
import { getAnsiPolicy, motionClock, setAnsiPolicy, TERMINAL, visibleWidth } from "@veyyon/tui";
import { MODAL_SIZING_SETTINGS, renderModalShell } from "../../../src/modes/components/modal-shell";
import { resetGroundTintsForTest, setDetectedTerminalGround } from "../../../src/modes/theme/ground-tints";
import { initTheme } from "../../../src/modes/theme/theme";
import { OVERLAY_SPECS, type RenderableOverlay } from "./overlay-specs";

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "dark");
});

afterEach(() => {
	motionClock.clear();
});

/**
 * Every column of a row that carries a truecolor background, walked the way a
 * terminal walks it: visible width for text, parameters for the colour. A
 * column set rather than a span list, because the claim is about WHERE paint
 * lands, and a span that starts inside the card and runs off its edge is the
 * defect a start-column list would call clean.
 */
function paintedColumns(line: string): Set<number> {
	const painted = new Set<number>();
	const sgr = /\x1b\[([0-9;:]*)m/g;
	let col = 0;
	let index = 0;
	let background: string | null = null;
	const advance = (text: string): void => {
		const width = visibleWidth(text);
		for (let step = 0; step < width; step++) {
			if (background !== null) painted.add(col + step);
		}
		col += width;
	};
	for (let match = sgr.exec(line); match !== null; match = sgr.exec(line)) {
		advance(line.slice(index, match.index));
		index = match.index + match[0].length;
		const params = match[1] ?? "";
		if (params.includes("48;2")) background = params;
		else if (params === "49" || params === "0" || params === "") background = null;
	}
	advance(line.slice(index));
	return painted;
}

const OVERLAY_NAMES: readonly string[] = [
	"AccountManagerComponent",
	"AdvisorConfigOverlayComponent",
	"AgentDashboard",
	"AgentTranscriptViewer",
	"AskDialogComponent",
	"AutoresearchDashboardOverlay",
	"CopySelectorComponent",
	"ExtensionDashboard",
	"HistorySearchComponent",
	"HookEditorComponent",
	"HookInputComponent",
	"HookSelectorComponent",
	"LoginDialogComponent",
	"MCPAddWizard",
	"ModalSelectListComponent",
	"ModelHubComponent",
	"ModelPickerComponent",
	"MoveOverlay",
	"OAuthSelectorComponent",
	"PlanReviewOverlay",
	"QueueModeSelectorComponent",
	"ResetUsageSelectorComponent",
	"RollbackPickerComponent",
	"SessionSelectorComponent",
	"SettingsSelectorComponent",
	"ShowImagesSelectorComponent",
	"SubcommandPickerComponent",
	"SwarmSetupConsole",
	"ThemeSelectorComponent",
	"ThinkingSelectorComponent",
	"TreeSelectorComponent",
	"UserMessageSelectorComponent",
];

describe("a card's first rendered frame is byte-identical to its settled frame", () => {
	it("choke point: renderModalShell is purely static and deterministic across clock ticks", () => {
		const input = {
			title: "Choke Point Modal",
			sizing: MODAL_SIZING_SETTINGS,
			areaWidth: 100,
			areaHeight: 30,
			body: ["  Line 1", "  Line 2", "  Line 3"],
			searchLine: " / search",
			tipCandidates: ["Tip candidate 1"],
		};

		const now = performance.now();
		const frame0 = renderModalShell(input);
		motionClock.tick(now + 300);
		const frame300 = renderModalShell(input);
		motionClock.tick(now + 1000);
		const frame1000 = renderModalShell(input);

		expect([...frame0.lines]).toEqual([...frame300.lines]);
		expect([...frame0.lines]).toEqual([...frame1000.lines]);
		expect(frame0.geometry).toEqual(frame1000.geometry);
	});

	it("sweeps every constructable overlay component: frame 0 === settled frame", async () => {
		const unconstructable: string[] = [];

		for (const spec of OVERLAY_SPECS) {
			let component: RenderableOverlay;
			try {
				component = await spec.create();
			} catch (err) {
				unconstructable.push(`${spec.name}: ${err}`);
				continue;
			}

			// Frame 0: first render on open
			let firstFrame: readonly string[] | string[];
			try {
				firstFrame = component.render(100);
			} catch (err) {
				throw new Error(`Component ${spec.name} render failed: ${err}`);
			}
			expect(firstFrame.length).toBeGreaterThan(0);

			const now = performance.now();
			motionClock.tick(now + 260);
			const midFrame = component.render(100);
			motionClock.tick(now + 1000);
			const settledFrame = component.render(100);

			expect([...firstFrame]).toEqual([...midFrame]);
			expect([...firstFrame]).toEqual([...settledFrame]);

			if ("dispose" in component && typeof component.dispose === "function") {
				component.dispose();
			}
		}

		expect(unconstructable).toEqual([]);
	});

	it("names every overlay it sweeps, so a new card is red until someone decides", () => {
		expect([...OVERLAY_SPECS].map(spec => spec.name).sort()).toEqual([...OVERLAY_NAMES]);
	});

	// The entrance carried the only code that mixed a colour out of "the ground
	// behind this row", and a wash over every cell of a card reads as a film over
	// the page rather than an object on it. Its absence is a contract: this is the
	// exact configuration a returning fill would hide in, a truecolor terminal
	// whose ground is known.
	it("gives a card no fill of its own, and leaves a band the body supplied alone", () => {
		const policy: AnsiPolicy = getAnsiPolicy();
		const trueColorWas = TERMINAL.trueColor;
		const caps: { trueColor: boolean } = TERMINAL;
		setAnsiPolicy("full");
		caps.trueColor = true;
		setDetectedTerminalGround("#1e2127");
		try {
			const band = `\x1b[48;2;120;60;20m${"selected row".padEnd(40)}\x1b[49m`;
			const result = renderModalShell({
				title: "Settings",
				sizing: MODAL_SIZING_SETTINGS,
				areaWidth: 100,
				areaHeight: 30,
				body: ["plain row", band, "plain row"],
				shortcuts: [{ id: "close", label: "esc close" }],
			});
			const geometry = result.geometry;
			if (geometry === null) throw new Error("the card did not fit, so there is nothing to assert");

			const bandRow = result.lines.findIndex(line => line.includes("selected row"));
			expect(bandRow, "the band row is inside the card").toBeGreaterThanOrEqual(geometry.cardRowStart);
			expect(result.lines[bandRow]).toContain("48;2;120;60;20");

			for (let row = 0; row < result.lines.length; row++) {
				if (row === bandRow) continue;
				expect(paintedColumns(result.lines[row] ?? ""), `row ${row} carries a fill`).toEqual(new Set());
			}
		} finally {
			resetGroundTintsForTest();
			caps.trueColor = trueColorWas;
			setAnsiPolicy(policy);
		}
	});
});
