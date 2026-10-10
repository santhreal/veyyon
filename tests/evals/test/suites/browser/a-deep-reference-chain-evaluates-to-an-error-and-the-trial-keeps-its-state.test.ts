/**
 * WHY: Gridwork evaluates a formula by recursion through the cells it reads, and nothing bounded
 * how deep that went. A chain of cells whose formulas each nest deeply (a thousand signs before the
 * next reference) ran the stack out while evaluating, not while parsing, so the RangeError escaped:
 * the edit answered 500, every later page of the sheet answered 500, and the trial's `finish` threw
 * while reading the sheet's values, so the grader received no state at all.
 *
 * The first case writes such a chain through the page's own edit endpoint, then requires the edit
 * and the sheet page to answer, the chain's head to show an error value, and `finish` to return the
 * sheet's state. The second requires a chain as long as the sheet allows, a running total filled
 * down every row, to still compute: the bound must not cut a real sheet short.
 *
 * Not caught: a chain that nests exactly to the bound on a runtime whose frames are far larger than
 * this one's.
 */
import { describe, expect, it } from "bun:test";
import { TempDir } from "@veyyon/utils";
import { FormClient } from "../../../engine/kit/form-client";
import { trialSeed } from "../../../engine/kit/suite";
import { Evaluator, MAX_ROWS } from "../../../suites/browser/apps/sheet/formula";
import type { GridSnapshot } from "../../../suites/browser/apps/sheet/site";
import { SHEET_TASKS } from "../../../suites/browser/apps/sheet/tasks";

/** Cells Z1 to Z40: each negates the next a thousand times over, and Z40 holds 1. */
const CHAIN_LENGTH = 40;
const chain = Array.from({ length: CHAIN_LENGTH }, (_, index) => ({
	cell: `Z${index + 1}`,
	raw: index === CHAIN_LENGTH - 1 ? "1" : `=${"-".repeat(1000)}Z${index + 2}`,
}));

describe("a deep chain of references", () => {
	it("evaluates to an error value, and the page and the trial's state survive it", async () => {
		const task = SHEET_TASKS[0];
		if (!task) throw new Error("the sheet application has no task");
		await using dir = await TempDir.create("@evals-sheet-deep-chain-");
		const trial = await task.start({
			seed: trialSeed({ task: task.id, repeat: 0 }),
			workspace: dir.path(),
			trialDir: dir.path(),
		});
		const statuses: number[] = [];
		let book = "";
		let sheet = "";
		let page = "";
		let failure: unknown = null;
		try {
			const origin = /http:\/\/127\.0\.0\.1:\d+/.exec(trial.instruction)?.[0];
			if (!origin) throw new Error(`the instruction names no site: ${trial.instruction}`);
			const client = new FormClient(origin);
			book = /href="\/wb\/([A-Z0-9]+)"/.exec((await client.get("/")).body)?.[1] ?? "";
			const first = await client.get(`/wb/${book}`);
			sheet = decodeURIComponent(/href="\/wb\/[A-Z0-9]+\?sheet=([^"]+)"/.exec(first.body)?.[1] ?? "");
			statuses.push((await client.postJson(`/api/wb/${book}/cells`, { sheet, edits: chain })).status);
			const shown = await client.get(`/wb/${book}?sheet=${encodeURIComponent(sheet)}`);
			statuses.push(shown.status);
			page = shown.body;
		} catch (error) {
			failure = error;
		}
		// Stopped whether or not the requests threw, so a failing case leaves no server behind.
		const state = JSON.parse(JSON.stringify(await trial.finish())) as GridSnapshot;
		if (failure !== null) throw failure;
		expect(statuses).toEqual([200, 200]);
		expect(page).toContain('data-cell="Z1">#ERROR!</div>');
		const values = state.workbooks
			.find(entry => entry.id === book)
			?.sheets.find(entry => entry.name === sheet)?.values;
		expect(values?.Z1).toEqual({ error: "#ERROR!" });
		expect(values?.[`Z${CHAIN_LENGTH}`]).toBe(1);
	});

	it("still computes a running total filled down every row of a sheet", () => {
		const cells: Record<string, string> = { [`A${MAX_ROWS}`]: "0" };
		for (let row = 1; row < MAX_ROWS; row++) cells[`A${row}`] = `=ROUND(A${row + 1}+1,2)`;
		expect(new Evaluator([{ name: "Sheet", cells }]).value("Sheet", "A1")).toBe(MAX_ROWS - 1);
	});
});
