/**
 * Gridwork's world: workbooks of sheets whose cells hold raw inputs, and the one rule set every page
 * and every grader shares: how a sheet is edited, filled, sorted and filtered, and what it evaluates
 * to.
 */

import type { Seeded } from "../../../../engine/kit/seeded";
import {
	type CellValue,
	cellName,
	columnLetter,
	compareValues,
	displayValue,
	Evaluator,
	isError,
	parseCellName,
	type Rect,
	shiftFormula,
	type Value,
} from "./formula";

export interface CellComment {
	readonly author: string;
	readonly text: string;
}

export interface Sheet {
	readonly name: string;
	/** Raw inputs by address (`B7`); an empty cell has no entry. */
	cells: Record<string, string>;
	comments: Record<string, CellComment>;
	/** Per filtered column letter, the displayed values whose rows stay shown. */
	filters: Record<string, readonly string[]>;
}

export interface Workbook {
	readonly id: string;
	readonly name: string;
	readonly owner: string;
	/** `YYYY-MM-DD`. */
	readonly edited: string;
	readonly sheets: Sheet[];
}

export interface GridWorld {
	readonly user: string;
	readonly workbooks: Workbook[];
}

export type SortDirection = "asc" | "desc";

/** A sheet whose rows, from row 1, hold these inputs; null and "" leave a cell empty. */
export function sheetFrom(name: string, rows: readonly (readonly (string | number | null)[])[]): Sheet {
	const cells: Record<string, string> = {};
	rows.forEach((row, r) => {
		row.forEach((value, c) => {
			if (value !== null && value !== "") cells[cellName(c, r + 1)] = String(value);
		});
	});
	return { name, cells, comments: {}, filters: {} };
}

export function findWorkbook(world: GridWorld, id: string): Workbook | undefined {
	return world.workbooks.find(book => book.id === id);
}

export function findSheet(book: Workbook, name: string): Sheet | undefined {
	return book.sheets.find(sheet => sheet.name.toLowerCase() === name.toLowerCase());
}

export function evaluatorFor(book: Workbook): Evaluator {
	return new Evaluator(book.sheets);
}

/** The last row and column that hold an input, 0 and -1 on an empty sheet. */
export function usedBounds(sheet: Sheet): { lastRow: number; lastCol: number } {
	let lastRow = 0;
	let lastCol = -1;
	for (const name of Object.keys(sheet.cells)) {
		const address = parseCellName(name);
		if (!address) continue;
		lastRow = Math.max(lastRow, address.row);
		lastCol = Math.max(lastCol, address.col);
	}
	return { lastRow, lastCol };
}

/** Store what was typed into a cell: trimmed, one line, and nothing at all when it is blank. */
export function setCell(sheet: Sheet, cell: string, raw: string): void {
	const value = raw.replaceAll(/[\r\n]+/g, " ").trim();
	if (value === "") delete sheet.cells[cell];
	else sheet.cells[cell] = value;
}

/**
 * Fill `target` from `source`, which is its top-left block: every cell outside `source` takes the
 * input of the source cell the same distance into the repeating block, its formula shifted by how
 * far it moved. Returns an error message when the blocks do not fit that shape.
 */
export function fillRect(sheet: Sheet, source: Rect, target: Rect): string | null {
	if (source.c1 !== target.c1 || source.r1 !== target.r1 || source.c2 > target.c2 || source.r2 > target.r2) {
		return "the fill target must extend the selection down or to the right";
	}
	const width = source.c2 - source.c1 + 1;
	const height = source.r2 - source.r1 + 1;
	for (let r = target.r1; r <= target.r2; r++) {
		for (let c = target.c1; c <= target.c2; c++) {
			if (r <= source.r2 && c <= source.c2) continue;
			const fromCol = source.c1 + ((c - source.c1) % width);
			const fromRow = source.r1 + ((r - source.r1) % height);
			const raw = sheet.cells[cellName(fromCol, fromRow)];
			const cell = cellName(c, r);
			if (raw === undefined) delete sheet.cells[cell];
			else sheet.cells[cell] = shiftFormula(raw, c - fromCol, r - fromRow);
		}
	}
	return null;
}

/**
 * Sort rows 2 and below (row 1 is the header) by the values in one column. Rows move whole, with
 * their comments; empty and error keys go last in both directions; ties keep their order. A formula
 * in a moved row is shifted by the rows it moved.
 */
export function sortRows(book: Workbook, sheet: Sheet, col: number, direction: SortDirection): void {
	const { lastRow, lastCol } = usedBounds(sheet);
	if (lastRow < 3) return;
	const evaluator = evaluatorFor(book);
	const rows: { row: number; key: number | string | boolean | null }[] = [];
	for (let row = 2; row <= lastRow; row++) {
		const value = evaluator.value(sheet.name, cellName(col, row));
		rows.push({ row, key: isError(value) ? null : value });
	}
	rows.sort((a, b) => {
		if (a.key === null || b.key === null) return (a.key === null ? 1 : 0) - (b.key === null ? 1 : 0);
		const order = compareValues(a.key, b.key);
		return direction === "asc" ? order : -order;
	});
	const cells: Record<string, string> = {};
	const comments: Record<string, CellComment> = {};
	for (const [name, raw] of Object.entries(sheet.cells)) {
		if ((parseCellName(name)?.row ?? 0) === 1) cells[name] = raw;
	}
	for (const [name, comment] of Object.entries(sheet.comments)) {
		if ((parseCellName(name)?.row ?? 0) === 1) comments[name] = comment;
	}
	rows.forEach((entry, index) => {
		const to = index + 2;
		for (let c = 0; c <= lastCol; c++) {
			const from = cellName(c, entry.row);
			const raw = sheet.cells[from];
			if (raw !== undefined) cells[cellName(c, to)] = shiftFormula(raw, 0, to - entry.row);
			const comment = sheet.comments[from];
			if (comment) comments[cellName(c, to)] = comment;
		}
	});
	sheet.cells = cells;
	sheet.comments = comments;
}

/**
 * What a cell shows: a typed number keeps the form it was typed in (`45.10`, `1,250`), as a
 * spreadsheet keeps the format it infers from the input; everything else shows its value.
 */
export function shownText(raw: string | undefined, value: Value): string {
	return raw !== undefined && !raw.startsWith("=") && typeof value === "number" ? raw : displayValue(value);
}

/** Rows 2 and below that a filter hides: a row shows only when every filtered column's text is shown. */
export function hiddenRows(book: Workbook, sheet: Sheet): Set<number> {
	const hidden = new Set<number>();
	const filters = Object.entries(sheet.filters);
	if (filters.length === 0) return hidden;
	const evaluator = evaluatorFor(book);
	const { lastRow } = usedBounds(sheet);
	for (let row = 2; row <= lastRow; row++) {
		for (const [letter, shown] of filters) {
			const cell = `${letter}${row}`;
			if (!shown.includes(shownText(sheet.cells[cell], evaluator.value(sheet.name, cell)))) {
				hidden.add(row);
				break;
			}
		}
	}
	return hidden;
}

/** The sheet's values as CSV, row 1 to its last used row, column A to its last used column. */
export function sheetCsv(book: Workbook, sheet: Sheet): string {
	const evaluator = evaluatorFor(book);
	const { lastRow, lastCol } = usedBounds(sheet);
	const lines: string[] = [];
	for (let row = 1; row <= lastRow; row++) {
		const fields: string[] = [];
		for (let col = 0; col <= lastCol; col++) {
			const cell = cellName(col, row);
			const text = shownText(sheet.cells[cell], evaluator.value(sheet.name, cell));
			fields.push(/[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text);
		}
		lines.push(fields.join(","));
	}
	return `${lines.join("\r\n")}\r\n`;
}

/** Every non-empty cell's value, for a grader: JSON keeps numbers, text, booleans and `{error}`. */
export function sheetValues(book: Workbook, sheet: Sheet): Record<string, CellValue> {
	const evaluator = evaluatorFor(book);
	const values: Record<string, CellValue> = {};
	for (const name of Object.keys(sheet.cells)) {
		const value = evaluator.value(sheet.name, name);
		if (value !== null) values[name] = value;
	}
	return values;
}

export function columnOf(sheet: Sheet, header: string): string {
	for (const [name, raw] of Object.entries(sheet.cells)) {
		const address = parseCellName(name);
		if (address?.row === 1 && raw.toLowerCase() === header.toLowerCase()) return columnLetter(address.col);
	}
	throw new Error(`${sheet.name} has no column headed "${header}"`);
}

// ---------------------------------------------------------------------------------------------
// Seeded names and the workbooks every world holds besides a task's own

export const PEOPLE = [
	"Avery Lindqvist",
	"Jordan Okafor",
	"Riley Moreau",
	"Morgan Castillo",
	"Casey Haddad",
	"Taylor Novak",
	"Quinn Brennan",
	"Rowan Nakamura",
	"Sasha Ivers",
	"Devon Achebe",
	"Harper Solberg",
	"Emerson Vale",
];

export const COMPANIES = [
	"Alder & Finch",
	"Brightwell Co",
	"Cobalt Studio",
	"Driftwood Cafe",
	"Evergreen Clinic",
	"Foxglove Books",
	"Granite Works",
	"Harborview Hotel",
	"Ironbark Gym",
	"Juniper School",
	"Kestrel Labs",
	"Lumen Dental",
	"Marigold Florist",
	"Northgate Motors",
	"Oakridge Farm",
	"Pinecrest Realty",
];

export const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

export function isoDate(year: number, month: number, day: number): string {
	return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

export function newWorkbook(rng: Seeded, name: string, sheets: Sheet[], owner = rng.pick(PEOPLE)): Workbook {
	return { id: rng.code(8), name, owner, edited: isoDate(2026, rng.int(6, 9), rng.int(1, 28)), sheets };
}

function budgetWorkbook(rng: Seeded): Workbook {
	const lines = ["Rent", "Payroll", "Software", "Travel", "Marketing", "Utilities", "Training", "Equipment"];
	const rows: (string | number)[][] = [["Category", "Planned", "Actual", "Variance"]];
	lines.forEach((line, index) => {
		const planned = rng.int(20, 400) * 50;
		rows.push([line, planned, planned + rng.int(-40, 40) * 25, `=C${index + 2}-B${index + 2}`]);
	});
	rows.push([
		"Total",
		`=SUM(B2:B${lines.length + 1})`,
		`=SUM(C2:C${lines.length + 1})`,
		`=C${lines.length + 2}-B${lines.length + 2}`,
	]);
	return newWorkbook(rng, "Team Budget 2026", [sheetFrom("Budget", rows)]);
}

function contactsWorkbook(rng: Seeded): Workbook {
	const rows: string[][] = [["Vendor", "Contact", "Terms", "Region"]];
	for (const company of rng.sample(COMPANIES, 9)) {
		rows.push([
			company,
			rng.pick(PEOPLE),
			rng.pick(["Net 15", "Net 30", "Net 45", "On receipt"]),
			rng.pick(["North", "South", "East", "West"]),
		]);
	}
	return newWorkbook(rng, "Vendor Contacts", [sheetFrom("Vendors", rows)]);
}

function headcountWorkbook(rng: Seeded): Workbook {
	const rows: (string | number)[][] = [["Name", "Team", "Attending", "Guests"]];
	for (const person of rng.sample(PEOPLE, 10)) {
		rows.push([
			person,
			rng.pick(["Design", "Sales", "Support", "Finance"]),
			rng.pick(["Yes", "Yes", "No", "Maybe"]),
			rng.int(0, 2),
		]);
	}
	rows.push(["", "", "Total guests", "=SUM(D2:D11)"]);
	return newWorkbook(rng, "Offsite Headcount", [sheetFrom("RSVPs", rows)]);
}

/** The workbooks a world holds besides the task's own, which the checks expect untouched. */
export function otherWorkbooks(rng: Seeded): Workbook[] {
	return [budgetWorkbook(rng), contactsWorkbook(rng), headcountWorkbook(rng)];
}

/** A world of the task's workbooks and the usual others, listed in a seeded order. */
export function worldOf(rng: Seeded, books: readonly Workbook[]): GridWorld {
	return { user: rng.pick(PEOPLE), workbooks: rng.shuffle([...books, ...otherWorkbooks(rng)]) };
}
