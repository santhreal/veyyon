/**
 * WHY: Gridwork shows a cell's comment only while the pointer rests on the cell, and a pre-applied
 * filter hides rows, so a correction written in a hidden row's comment is found only by noticing the
 * filter. The grid served the hidden rows with their comment marks, and the comment endpoint answered
 * for them, so a page read of `.has-comment` plus one fetch found the hidden correction with the
 * filter still on: `sheet-fix-flagged-cells` then passed its filtered-row check without the filter
 * handling it claims to test.
 *
 * This suite crawls every workbook and sheet of every sheet task, as the site serves them, over
 * several seeds: no cell of a row a filter hides carries the comment mark or has its comment served,
 * and once the filters are cleared every commented cell of those rows is marked and served, so the
 * task stays solvable through the page. A new sheet task joins the sweep through `SHEET_TASKS`.
 *
 * Not caught: a hidden row's values, which the page holds for its filter menu, or a comment leaked
 * through a channel other than the grid's markup and the comment endpoint.
 */
import { describe, expect, it } from "bun:test";
import { TempDir } from "@veyyon/utils";
import { FormClient } from "../../../engine/kit/form-client";
import { trialSeed } from "../../../engine/kit/suite";
import { SHEET_TASKS } from "../../../suites/browser/apps/sheet/tasks";

const REPEATS = [0, 1, 2, 3];

interface GridRow {
	readonly row: number;
	readonly hidden: boolean;
	readonly cells: readonly { readonly cell: string; readonly commented: boolean }[];
}

/** The grid's data rows as the sheet page renders them. */
function gridRows(body: string): GridRow[] {
	const starts = [...body.matchAll(/<div class="grow"[^>]*\bdata-row="(\d+)"([^>]*)>/g)];
	return starts.map((start, index) => {
		const end = starts[index + 1]?.index ?? body.length;
		const segment = body.slice(start.index, end);
		return {
			row: Number(start[1]),
			hidden: /\bhidden\b/.test(start[2] ?? ""),
			cells: [...segment.matchAll(/<div class="([^"]*)"[^>]*\bdata-cell="([A-Z]+\d+)"/g)].map(match => ({
				cell: match[2] as string,
				commented: (match[1] ?? "").split(" ").includes("has-comment"),
			})),
		};
	});
}

function originOf(instruction: string): string {
	const origin = /http:\/\/127\.0\.0\.1:\d+/.exec(instruction)?.[0];
	if (!origin) throw new Error(`the instruction names no site: ${instruction}`);
	return origin;
}

describe("a comment in a row a sheet filter hides", () => {
	it("is neither marked nor served until the filter is cleared, and then is both", async () => {
		const violations: string[] = [];
		let revealed = 0;
		for (const task of SHEET_TASKS) {
			for (const repeat of REPEATS) {
				await using dir = await TempDir.create("@evals-sheet-comments-");
				const trial = await task.start({
					seed: trialSeed({ task: task.id, repeat }),
					workspace: dir.path(),
					trialDir: dir.path(),
				});
				try {
					const client = new FormClient(originOf(trial.instruction));
					const home = await client.get("/");
					const books = [...new Set([...home.body.matchAll(/href="\/wb\/([A-Z0-9]+)"/g)].map(match => match[1]))];
					for (const book of books) {
						const first = await client.get(`/wb/${book}`);
						const sheets = [...first.body.matchAll(/href="\/wb\/[A-Z0-9]+\?sheet=([^"]+)"/g)].map(match =>
							decodeURIComponent(match[1] as string),
						);
						for (const sheet of sheets) {
							const where = `${task.id} #${repeat} ${book}/${sheet}`;
							const pagePath = `/wb/${book}?sheet=${encodeURIComponent(sheet)}`;
							const comment = (cell: string) =>
								client.get(`/api/wb/${book}/comment?sheet=${encodeURIComponent(sheet)}&cell=${cell}`);
							const hiddenRows = gridRows((await client.get(pagePath)).body).filter(row => row.hidden);
							for (const row of hiddenRows) {
								for (const { cell, commented } of row.cells) {
									if (commented) violations.push(`${where}: hidden ${cell} is marked as commented`);
									const served = await comment(cell);
									if (served.status !== 404)
										violations.push(`${where}: hidden ${cell} answered ${served.status}`);
								}
							}
							if (hiddenRows.length === 0) continue;
							const cleared = await client.postJson(`/api/wb/${book}/filter`, {
								sheet,
								col: null,
								values: null,
							});
							if (cleared.status !== 200)
								throw new Error(`${where}: clearing the filters answered ${cleared.status}`);
							const wasHidden = new Set(hiddenRows.map(row => row.row));
							const shown = gridRows((await client.get(pagePath)).body).filter(row => wasHidden.has(row.row));
							for (const row of shown) {
								if (row.hidden) violations.push(`${where}: row ${row.row} stays hidden without a filter`);
								for (const { cell } of row.cells.filter(entry => entry.commented)) {
									const served = await comment(cell);
									if (served.status === 200) revealed++;
									else violations.push(`${where}: shown ${cell} is marked but answered ${served.status}`);
								}
							}
						}
					}
				} finally {
					await trial.finish();
				}
			}
		}
		expect(violations).toEqual([]);
		// The sweep met hidden comments: sheet-fix-flagged-cells hides a correction in every seed.
		expect(revealed).toBeGreaterThanOrEqual(REPEATS.length);
	});
});
