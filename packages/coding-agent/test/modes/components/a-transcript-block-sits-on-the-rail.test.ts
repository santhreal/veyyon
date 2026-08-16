/**
 * A transcript block that owns a turn sits on the transcript's one left rail
 * and draws no full-width rule.
 *
 * WHY: `/btw` and `/omfg` painted a `───` rule at column 0 above and below four
 * short lines, and indented their content one column. That is two defects in
 * one block: the loudest thing on the screen was chrome, and it sat two columns
 * off the rail every other block follows (`COMPOSER_INSET_COLS`, owned by
 * `composer-chrome.ts`). The execution blocks had already settled this — see
 * `buildExecutionFrame` — so these two were the surviving exceptions.
 *
 * The class this closes is "a block that invents its own geometry": the
 * assertions run over EVERY state each panel can paint, driven through the
 * panel's own public methods, and they read the painted rows rather than the
 * child list, so a future block that reintroduces a rule or an inset of its own
 * fails here whichever way it builds it. The state maps are keyed by the
 * exported state unions, so adding a state without deciding what it paints does
 * not type check. The two composer-zone members are here for the same reason —
 * the pinned error banner and the loader that takes the composer's place both
 * drew the same pair of rules, in a zone whose rule is that it has no box.
 *
 * The component that drew every one of those rules is deleted, so the closure
 * is structural as well: there is no full-width rule component left to reach
 * for.
 *
 * What it does not catch: a NEW transcript component that never routes through
 * `mountTranscriptBlock` is not enumerable from source (a transcript child is
 * any `Component`), so it is not swept here. The debug protocol probe is not
 * driven either — it needs an image budget and a decoded PNG, and its geometry
 * is the same two calls the others make. It also says nothing about colour: the
 * rail is geometry, and the tone of a header is a theme question proven by the
 * render-proof images.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { BtwPanelComponent, type BtwPanelState } from "@veyyon/coding-agent/modes/components/btw-panel";
import { COMPOSER_INSET_COLS } from "@veyyon/coding-agent/modes/components/composer-chrome";
import { ComposerLoader } from "@veyyon/coding-agent/modes/components/composer-loader";
import { ErrorBannerComponent } from "@veyyon/coding-agent/modes/components/error-banner";
import { OmfgPanelComponent, type OmfgPanelState } from "@veyyon/coding-agent/modes/components/omfg-panel";
import { TinyTitleDownloadProgressComponent } from "@veyyon/coding-agent/modes/components/tiny-title-download-progress";
import {
	mountTranscriptBlock,
	transcriptBlockText,
} from "@veyyon/coding-agent/modes/components/transcript-block-chrome";
import { TranscriptBlock } from "@veyyon/coding-agent/modes/components/transcript-container";
import { showCommandMessage } from "@veyyon/coding-agent/modes/controllers/command-controller-shared";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { TinyTitleProgressEvent, TinyTitleProgressStatus } from "@veyyon/coding-agent/tiny/title-protocol";
import type { Component, TUI } from "@veyyon/tui";

const WIDTH = 100;

function strip(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function stubUi(): TUI {
	return { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
}

/** Every painted row, ANSI removed, in render order. */
function paintedRows(component: { render(width: number): readonly string[] }): string[] {
	return component.render(WIDTH).map(strip);
}

function assertOnTheRail(rows: string[], label: string): void {
	for (const row of rows) {
		if (row.trim() === "") continue;
		const inset = row.length - row.trimStart().length;
		// The row text is carried for a readable failure; `inset` is the claim.
		expect({ label, row: row.trim().slice(0, 24), inset }).toEqual({
			label,
			row: row.trim().slice(0, 24),
			inset: COMPOSER_INSET_COLS,
		});
	}
}

function assertNoFullWidthRule(rows: string[], label: string): void {
	for (const row of rows) {
		const body = row.trim();
		if (body.length < 8) continue;
		const ruleGlyphs = /^[─━–—-]+$/;
		expect({ label, row: body.slice(0, 16), isRule: ruleGlyphs.test(body) }).toEqual({
			label,
			row: body.slice(0, 16),
			isRule: false,
		});
	}
}

/** Drive one panel into each state through its own public API. */
const BTW_STATES: Record<BtwPanelState, (panel: BtwPanelComponent) => void> = {
	running: panel => panel.appendText("partial answer"),
	complete: panel => {
		panel.setAnswer("A **focus string** names the tests a run executes.");
		panel.markComplete();
	},
	aborted: panel => panel.markAborted(),
	error: panel => panel.markError("provider refused the request"),
};

const OMFG_STATES: Record<OmfgPanelState, (panel: OmfgPanelComponent) => void> = {
	generating: panel => panel.appendDraft("## Imports\n\nNever reorder"),
	validating: panel => panel.setStatus("validating", "Checking the rule…"),
	confirming: panel => {
		panel.setRule("## Imports\n\nNever reorder an untouched import block.");
		panel.setStatus("confirming", "Save this rule? y/n");
	},
	saving: panel => panel.setStatus("saving", "Writing AGENTS.md…"),
	saved: panel => panel.markSaved("/repo/AGENTS.md"),
	rejected: panel => panel.markRejected(),
	aborted: panel => panel.markAborted(),
	error: panel => panel.markError("rule failed validation"),
};

describe("a transcript block sits on the rail", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	it("paints every /btw state at the rail, with no rule", () => {
		for (const [state, drive] of Object.entries(BTW_STATES)) {
			const panel = new BtwPanelComponent({ question: "what is a focus string?", tui: stubUi() });
			drive(panel);
			const rows = paintedRows(panel);
			assertOnTheRail(rows, `btw/${state}`);
			assertNoFullWidthRule(rows, `btw/${state}`);
		}
	});

	it("paints every /omfg state at the rail, with no rule", () => {
		for (const [state, drive] of Object.entries(OMFG_STATES)) {
			const panel = new OmfgPanelComponent({ complaint: "stop reformatting my imports", tui: stubUi() });
			drive(panel);
			const rows = paintedRows(panel);
			assertOnTheRail(rows, `omfg/${state}`);
			assertNoFullWidthRule(rows, `omfg/${state}`);
		}
	});

	it("opens each block with the command that made it", () => {
		const btw = new BtwPanelComponent({ question: "what is a focus string?", tui: stubUi() });
		expect(paintedRows(btw)[0]?.trimEnd()).toBe(`${" ".repeat(COMPOSER_INSET_COLS)}/btw what is a focus string?`);

		const omfg = new OmfgPanelComponent({ complaint: "stop reformatting my imports", tui: stubUi() });
		expect(paintedRows(omfg)[0]?.trimEnd()).toBe(
			`${" ".repeat(COMPOSER_INSET_COLS)}/omfg stop reformatting my imports`,
		);
	});

	it("keeps the hint row last, so the block ends on what to press", () => {
		const panel = new BtwPanelComponent({ question: "what is a focus string?", tui: stubUi() });
		panel.setAnswer("An answer.");
		panel.markComplete();
		const rows = paintedRows(panel).filter(row => row.trim() !== "");
		expect(rows.at(-1)?.trimEnd()).toBe(`${" ".repeat(COMPOSER_INSET_COLS)}c copy · b branch to chat · Esc dismiss`);
	});

	it("presents a command's answer at the rail, with no rule", () => {
		const presented: Component[] = [];
		showCommandMessage({ present: (block: Component) => presented.push(block) }, "Server added: local-fs");

		const block = presented[0];
		if (!block) throw new Error("showCommandMessage presented nothing");
		const rows = paintedRows(block);
		assertOnTheRail(rows, "command-message");
		assertNoFullWidthRule(rows, "command-message");
		expect(rows.map(row => row.trimEnd())).toEqual([`${" ".repeat(COMPOSER_INSET_COLS)}Server added: local-fs`]);
	});

	it("drops the header gap for a block that has no header", () => {
		const withHeader = new TranscriptBlock();
		mountTranscriptBlock(withHeader, { header: "Title", body: transcriptBlockText("body") });
		expect(paintedRows(withHeader).map(row => row.trimEnd())).toEqual(["  Title", "", "  body"]);

		const bare = new TranscriptBlock();
		mountTranscriptBlock(bare, { body: transcriptBlockText("body") });
		expect(paintedRows(bare).map(row => row.trimEnd())).toEqual(["  body"]);
	});

	it("pins the error banner to the rail, with no rule", () => {
		const banner = new ErrorBannerComponent("Output blocked by content filtering policy");
		const rows = paintedRows(banner);
		assertOnTheRail(rows, "error-banner");
		assertNoFullWidthRule(rows, "error-banner");
		expect(rows.filter(row => row.trim() !== "").length).toBe(2);
	});

	it("puts the composer loader's hint on the rail, with no rule", () => {
		const loader = new ComposerLoader(stubUi(), theme, "Sharing session...");
		try {
			const rows = paintedRows(loader);
			assertNoFullWidthRule(rows, "composer-loader");
			expect(rows.at(-1)?.trimEnd()).toBe(`${" ".repeat(COMPOSER_INSET_COLS)}esc cancel`);
		} finally {
			loader.dispose();
		}
	});

	/**
	 * The tiny-title download block was the last bordered band in the transcript:
	 * a rule above and below, rows padded edge to edge from column zero. Keyed by
	 * the exported status union, so a new progress status does not type check
	 * until someone decides what it paints.
	 */
	it("paints every tiny-model download status at the rail, with no rule", () => {
		const events: Record<TinyTitleProgressStatus, TinyTitleProgressEvent> = {
			initiate: { modelKey: "lfm2-700m", status: "initiate", name: "onnx-community/LFM2-700M-ONNX" },
			download: { modelKey: "lfm2-700m", status: "download", file: "onnx/model_q4.onnx" },
			progress: { modelKey: "lfm2-700m", status: "progress", progress: 12.5, loaded: 1_250, total: 10_000 },
			progress_total: {
				modelKey: "lfm2-700m",
				status: "progress_total",
				progress: 50,
				loaded: 50_000_000,
				total: 100_000_000,
				files: { "onnx/model_q4.onnx": { loaded: 50_000_000, total: 100_000_000 } },
			},
			done: { modelKey: "lfm2-700m", status: "done", progress: 100, loaded: 100, total: 100 },
			ready: { modelKey: "lfm2-700m", status: "ready", task: "text-generation", model: "repo" },
			error: { modelKey: "lfm2-700m", status: "error" },
		};

		for (const [status, event] of Object.entries(events)) {
			const component = new TinyTitleDownloadProgressComponent("lfm2-700m");
			component.update(event);
			const rows = paintedRows(component);
			assertOnTheRail(rows, `tiny-download/${status}`);
			assertNoFullWidthRule(rows, `tiny-download/${status}`);
			expect(rows[0]?.trimEnd().startsWith(`${" ".repeat(COMPOSER_INSET_COLS)}Tiny model`)).toBe(true);
		}
	});
});
