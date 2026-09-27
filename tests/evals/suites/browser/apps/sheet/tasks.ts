/**
 * Tasks performed in Gridwork. Each builds its workbook from the seed, bending the data so the answer
 * is unique and the tempting wrong answers exist, then grades the raw inputs and evaluated values the
 * server recorded.
 */

import { type KitTask, kitTask } from "../../../../engine/kit/catalog";
import { answerHasNumber, answerHasText, normalizeText } from "../../../../engine/kit/checks";
import { FormClient } from "../../../../engine/kit/form-client";
import { Seeded } from "../../../../engine/kit/seeded";
import {
	COMPANIES,
	columnOf,
	type GridWorld,
	isoDate,
	MONTHS,
	newWorkbook,
	PEOPLE,
	type Sheet,
	sheetFrom,
	type Workbook,
	worldOf,
} from "./data";
import { type CellValue, columnIndex, formulaReferences, parseCellName } from "./formula";
import { type GridSnapshot, type SheetState, startSheetSite } from "./site";

/** Every workbook's raw inputs, by workbook id, then sheet name, then address. */
type Inputs = Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>;

interface Expected<T> {
	readonly expected: T & { readonly book: string; readonly before: Inputs };
}

type SheetTaskState<T> = GridSnapshot & Expected<T>;

function inputsOf(world: GridWorld): Inputs {
	return Object.fromEntries(
		world.workbooks.map(book => [
			book.id,
			Object.fromEntries(book.sheets.map(sheet => [sheet.name, { ...sheet.cells }])),
		]),
	);
}

function cellKey(book: string, sheet: string, cell: string): string {
	return `${book}/${sheet}!${cell}`;
}

/** Every cell of every workbook whose raw input differs from `before`, as {@link cellKey}s. */
function changedCells(state: GridSnapshot, before: Inputs): string[] {
	const after: Inputs = Object.fromEntries(
		state.workbooks.map(book => [book.id, Object.fromEntries(book.sheets.map(sheet => [sheet.name, sheet.cells]))]),
	);
	const changed: string[] = [];
	for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const was = before[id] ?? {};
		const now = after[id] ?? {};
		for (const sheet of new Set([...Object.keys(was), ...Object.keys(now)])) {
			const x = was[sheet] ?? {};
			const y = now[sheet] ?? {};
			for (const cell of new Set([...Object.keys(x), ...Object.keys(y)])) {
				if (x[cell] !== y[cell]) changed.push(cellKey(id, sheet, cell));
			}
		}
	}
	return changed;
}

function onlyChanged(state: SheetTaskState<unknown>, allowed: readonly string[]): boolean {
	const permitted = new Set(allowed);
	return changedCells(state, state.expected.before).every(key => permitted.has(key));
}

function sheetOf(state: SheetTaskState<unknown>, sheet: string): SheetState | undefined {
	return state.workbooks.find(book => book.id === state.expected.book)?.sheets.find(entry => entry.name === sheet);
}

function numberNear(value: CellValue | undefined, expected: number, tolerance: number): boolean {
	return typeof value === "number" && Math.abs(value - expected) <= tolerance;
}

/** Whether a formula reads the cell, directly or inside a range, on its own sheet `home`. */
function readsCell(raw: string, home: string, col: number, row: number): boolean {
	return formulaReferences(raw).some(
		ref =>
			(ref.sheet === null || ref.sheet.toLowerCase() === home.toLowerCase()) &&
			ref.c1 <= col &&
			col <= ref.c2 &&
			ref.r1 <= row &&
			row <= (ref.r2 ?? Number.POSITIVE_INFINITY),
	);
}

/** Cents as `1,250.00`. */
function amount(cents: number): string {
	const sign = cents < 0 ? "-" : "";
	const magnitude = Math.abs(cents);
	const whole = String(Math.floor(magnitude / 100)).replaceAll(/\B(?=(\d{3})+(?!\d))/g, ",");
	return `${sign}${whole}.${String(magnitude % 100).padStart(2, "0")}`;
}

/** Cents as a plain input, `-45.10`. */
function plainAmount(cents: number): string {
	return amount(cents).replaceAll(",", "");
}

async function postOk(client: FormClient, path: string, body: unknown): Promise<void> {
	const response = await client.postJson(path, body);
	if (response.status !== 200) throw new Error(`${path} answered ${response.status}: ${response.body}`);
}

function intro(origin: string): string {
	return `Gridwork is a spreadsheet application at ${origin}.`;
}

const ADJECTIVES = [
	"Amber",
	"Birch",
	"Cedar",
	"Dune",
	"Ember",
	"Frost",
	"Grove",
	"Harbor",
	"Indigo",
	"Jade",
	"Kelp",
	"Lark",
	"Moss",
	"Nimbus",
	"Onyx",
	"Pebble",
	"Quartz",
	"Ridge",
	"Slate",
	"Tidal",
];

const NOUN_CATEGORY: Readonly<Record<string, string>> = {
	Mug: "Kitchen",
	Kettle: "Kitchen",
	Tumbler: "Kitchen",
	"Cutting Board": "Kitchen",
	Lantern: "Outdoor",
	Backpack: "Outdoor",
	Planter: "Outdoor",
	Hammock: "Outdoor",
	Notebook: "Office",
	"Desk Tray": "Office",
	"Pen Set": "Office",
	"Monitor Stand": "Office",
	Blanket: "Home",
	Candle: "Home",
	"Throw Pillow": "Home",
	Vase: "Home",
};

/** `count` distinct product names, an adjective and a noun each, so no name contains another. */
function productNames(rng: Seeded, count: number): { name: string; noun: string }[] {
	const all = ADJECTIVES.flatMap(adjective =>
		Object.keys(NOUN_CATEGORY).map(noun => ({ name: `${adjective} ${noun}`, noun })),
	);
	return rng.sample(all, count);
}

function shortDate(month: number, day: number): string {
	return `${MONTHS[month - 1]?.slice(0, 3)} ${day}`;
}

// ---------------------------------------------------------------------------------------------
// sheet-fill-line-totals

interface LineTotals {
	readonly bookName: string;
	readonly qtyCol: string;
	readonly priceCol: string;
	readonly totalCol: string;
	readonly lastRow: number;
	/** The expected total of rows 2 to `lastRow`, in cents. */
	readonly totalCents: readonly number[];
}

const ORDER_ITEMS = [
	"Copy paper (case)",
	"Toner cartridge",
	"Desk lamp",
	"Ergonomic chair",
	"Whiteboard markers",
	"Label maker",
	"Stapler",
	"File boxes",
	"Monitor arm",
	"USB-C hub",
	"Notebook pack",
	"Shipping tape",
	"Coffee beans (kg)",
	"Hand soap refill",
	"Paper towels",
	"Cable ties (bag)",
];

/** Thousandths as an input: `12.50` when the last digit is 0, else `4.125`. */
function thousandths(value: number): string {
	const fraction = String(value % 1000).padStart(3, "0");
	return `${Math.floor(value / 1000)}.${value % 10 === 0 ? fraction.slice(0, 2) : fraction}`;
}

interface OrderRows {
	readonly sheet: Sheet;
	readonly quantities: readonly number[];
	readonly prices: readonly number[];
}

/** An orders sheet whose Quantity and Unit price sit among decoy columns; prices in thousandths. */
function ordersSheet(rng: Seeded, count: number, year: number, month: number, firstOrder: number): OrderRows {
	const headers = ["Order", "Date", "Customer", ...rng.shuffle(["Item", "Quantity", "Unit cost", "Unit price"])];
	const quantities: number[] = [];
	const prices: number[] = [];
	const days = Array.from({ length: count }, () => rng.int(1, 28)).sort((a, b) => a - b);
	for (let i = 0; i < count; i++) {
		quantities.push(rng.int(1, 60));
		prices.push(rng.next() < 0.45 ? rng.int(300, 90000) : rng.int(30, 9000) * 10);
	}
	// At least three rows whose exact total ends in a half cent or more, so leaving out the rounding
	// or truncating instead of rounding gives a wrong total.
	const roundingRows = () => quantities.filter((q, i) => (q * (prices[i] as number)) % 10 >= 5).length;
	for (const i of rng.shuffle(quantities.map((_, index) => index))) {
		if (roundingRows() >= 3) break;
		const q = quantities[i] as number;
		if (q % 10 === 0 || (q * (prices[i] as number)) % 10 >= 5) continue;
		const base = Math.floor((prices[i] as number) / 10) * 10;
		const digit = [1, 2, 3, 4, 5, 6, 7, 8, 9].find(k => (q * (base + k)) % 10 >= 5) as number;
		prices[i] = base + digit;
	}
	let order = firstOrder;
	const rows = quantities.map((quantity, i) => {
		order += rng.int(1, 4);
		const price = prices[i] as number;
		const values: Record<string, string | number> = {
			Order: `SO-${order}`,
			Date: isoDate(year, month, days[i] as number),
			Customer: rng.pick(COMPANIES),
			Item: rng.pick(ORDER_ITEMS),
			Quantity: quantity,
			"Unit cost": thousandths(Math.round((price * rng.int(45, 75)) / 1000) * 10),
			"Unit price": thousandths(price),
		};
		return headers.map(header => values[header] ?? "");
	});
	return { sheet: sheetFrom("Orders", [headers, ...rows]), quantities, prices };
}

function planLineTotals(rng: Seeded): { world: GridWorld; book: Workbook; plan: LineTotals } {
	const year = 2026;
	const month = rng.int(3, 9);
	const current = ordersSheet(rng, rng.int(28, 36), year, month, rng.int(4100, 4800));
	const returns = sheetFrom("Returns", [
		["Order", "Item", "Quantity", "Unit price", "Reason"],
		...Array.from({ length: rng.int(5, 8) }, () => [
			`SO-${rng.int(3000, 4000)}`,
			rng.pick(ORDER_ITEMS),
			rng.int(1, 6),
			thousandths(rng.int(30, 9000) * 10),
			rng.pick(["Damaged", "Wrong item", "Duplicate order"]),
		]),
	]);
	const bookName = `${MONTHS[month - 1]} Orders`;
	const book = newWorkbook(rng, bookName, [current.sheet, returns]);
	// Last month's workbook already has its Total column in H, typed as numbers.
	const previous = ordersSheet(rng, rng.int(12, 18), year, month - 1, rng.int(3000, 4000));
	previous.sheet.cells.H1 = "Total";
	previous.quantities.forEach((q, i) => {
		previous.sheet.cells[`H${i + 2}`] = plainAmount(Math.round((q * (previous.prices[i] as number)) / 10));
	});
	const previousBook = newWorkbook(rng, `${MONTHS[month - 2]} Orders`, [previous.sheet]);
	const world = worldOf(rng, [book, previousBook]);
	const qtyCol = columnOf(current.sheet, "Quantity");
	const priceCol = columnOf(current.sheet, "Unit price");
	return {
		world,
		book,
		plan: {
			bookName,
			qtyCol,
			priceCol,
			totalCol: "H",
			lastRow: current.quantities.length + 1,
			totalCents: current.quantities.map((q, i) => Math.round((q * (current.prices[i] as number)) / 10)),
		},
	};
}

function dataRows(plan: { readonly lastRow: number }): number[] {
	return Array.from({ length: plan.lastRow - 1 }, (_, i) => i + 2);
}

const fillLineTotals = kitTask<SheetTaskState<LineTotals>>({
	id: "sheet-fill-line-totals",
	title: "Add a rounded Total formula column to an orders sheet",
	capabilities: ["inline-edit", "keyboard", "reasoning"],
	difficulty: "medium",
	timeBudgetSec: 540,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const { world, book, plan } = planLineTotals(rng);
		const before = inputsOf(world);
		const site = await startSheetSite(world);
		return {
			instruction: [
				intro(site.origin),
				`Open the workbook "${plan.bookName}" and go to its Orders sheet. Add a Total column in the first empty column to the right of the existing data: the header "Total" in row 1, and in every order row a formula that computes that row's Quantity times its Unit price, rounded to cents (2 decimal places).`,
				"Use formulas that read the row's own cells, not typed numbers. Change nothing else in any workbook.",
				"Reply when you are done.",
			].join("\n"),
			solve: async () => {
				const client = new FormClient(site.origin);
				const path = `/api/wb/${book.id}`;
				const { totalCol, qtyCol, priceCol, lastRow } = plan;
				await postOk(client, `${path}/cells`, {
					sheet: "Orders",
					edits: [
						{ cell: `${totalCol}1`, raw: "Total" },
						{ cell: `${totalCol}2`, raw: `=ROUND(${qtyCol}2*${priceCol}2,2)` },
					],
				});
				await postOk(client, `${path}/fill`, {
					sheet: "Orders",
					source: `${totalCol}2`,
					target: `${totalCol}2:${totalCol}${lastRow}`,
				});
				return "The Total column is filled in.";
			},
			finish: async () => ({ ...(await site.finish()), expected: { ...plan, book: book.id, before } }),
		};
	},
	checks: [
		{
			id: "total-header",
			description: "the first empty column is headed Total",
			pass: state => normalizeText(sheetOf(state, "Orders")?.cells[`${state.expected.totalCol}1`] ?? "") === "total",
		},
		{
			id: "formula-each-row",
			description: "every order row's Total is a formula that reads the row's Quantity and Unit price",
			pass: state => {
				const sheet = sheetOf(state, "Orders");
				const { totalCol, qtyCol, priceCol } = state.expected;
				return dataRows(state.expected).every(row => {
					const raw = sheet?.cells[`${totalCol}${row}`] ?? "";
					return (
						raw.startsWith("=") &&
						readsCell(raw, "Orders", columnIndex(qtyCol), row) &&
						readsCell(raw, "Orders", columnIndex(priceCol), row)
					);
				});
			},
		},
		{
			id: "totals-exact",
			description: "every row's Total is Quantity times Unit price rounded to cents",
			pass: state => {
				const sheet = sheetOf(state, "Orders");
				return dataRows(state.expected).every(row =>
					numberNear(
						sheet?.values[`${state.expected.totalCol}${row}`],
						(state.expected.totalCents[row - 2] as number) / 100,
						1e-9,
					),
				);
			},
		},
		{
			id: "nothing-else-changed",
			description: "no other cell of any workbook changed",
			pass: state =>
				onlyChanged(
					state,
					[1, ...dataRows(state.expected)].map(row =>
						cellKey(state.expected.book, "Orders", `${state.expected.totalCol}${row}`),
					),
				),
		},
	],
});

// ---------------------------------------------------------------------------------------------
// sheet-fix-flagged-cells

interface Correction {
	readonly sheet: string;
	readonly cell: string;
	readonly value: number | string;
}

interface FlaggedCells {
	readonly bookName: string;
	/** In order: the row the filter hides, three visible Stock rows, the Suppliers sheet. */
	readonly corrections: readonly Correction[];
	/** Cells whose comment confirms the value. */
	readonly kept: readonly { readonly sheet: string; readonly cell: string }[];
}

const DOZENS: Readonly<Record<number, string>> = {
	12: "a dozen",
	24: "two dozen",
	36: "three dozen",
	48: "four dozen",
};

function planFlaggedCells(rng: Seeded): { world: GridWorld; book: Workbook; plan: FlaggedCells } {
	const month = rng.int(4, 8);
	const suppliers = rng.sample(COMPANIES, 5);
	const [filteredOut] = suppliers as [string];
	const count = rng.int(30, 36);
	const [renamedEntry, ...names] = productNames(rng, count + 1);
	if (!renamedEntry) throw new Error("no product name left for the renamed product");
	const renamed = renamedEntry.name;
	// Four products come from the supplier the filter hides, so it always hides some rows.
	const entries = rng.shuffle(
		names.map((entry, i) => ({ name: entry.name, supplier: i < 4 ? filteredOut : rng.pick(suppliers) })),
	);
	const stockRows = entries.map(entry => [
		`ST-${rng.code(4)}`,
		entry.name,
		entry.supplier,
		rng.int(0, 400),
		rng.int(10, 80),
		plainAmount(rng.int(150, 30000)),
	]);
	const stock = sheetFrom("Stock", [["SKU", "Item", "Supplier", "On hand", "Reorder at", "Unit cost"], ...stockRows]);
	const supplierSheet = sheetFrom("Suppliers", [
		["Supplier", "Contact", "Lead time (days)", "Minimum order"],
		...suppliers.map(name => [name, rng.pick(PEOPLE), rng.int(3, 30), rng.int(2, 40) * 5]),
	]);
	stock.filters = { C: suppliers.filter(name => name !== filteredOut) };

	const filteredRows = stockRows.flatMap((row, i) => (row[2] === filteredOut ? [i + 2] : []));
	const visibleRows = stockRows.flatMap((row, i) => (row[2] !== filteredOut ? [i + 2] : []));
	const bottom = visibleRows[visibleRows.length - 1] as number;
	const [invoiceRow, dozenRow, verifiedRow, priceRow] = rng.sample(visibleRows.slice(0, -1), 4) as [
		number,
		number,
		number,
		number,
	];
	const hiddenRow = rng.pick(filteredRows);
	const note = (sheet: Sheet, cell: string, text: string) => {
		sheet.comments[cell] = { author: rng.pick(PEOPLE), text };
	};
	const raw = (cell: string) => stock.cells[cell] as string;

	const recount = rng.int(0, 400);
	const oldCount = Number(raw(`D${hiddenRow}`));
	const newCount = recount === oldCount ? recount + 7 : recount;
	note(
		stock,
		`D${hiddenRow}`,
		`Recount on ${shortDate(month, rng.int(1, 28))}: ${newCount} on the shelf, not ${oldCount}.`,
	);

	const invoiceOld = rng.int(95000, 140000);
	stock.cells[`F${invoiceRow}`] = plainAmount(invoiceOld);
	const invoiceNew = invoiceOld + rng.int(4, 30) * 500;
	note(
		stock,
		`F${invoiceRow}`,
		`Invoice INV-${rng.int(1000, 9999)} bills $${amount(invoiceNew)} per unit, so this cost is wrong.`,
	);

	note(stock, `B${bottom}`, `The supplier renamed this product; it should read "${renamed}".`);

	const oldReorder = Number(raw(`E${dozenRow}`));
	const dozen = rng.pick([12, 24, 36, 48].filter(value => value !== oldReorder));
	note(stock, `E${dozenRow}`, `Reorder point should be ${DOZENS[dozen]}, not ${oldReorder}.`);

	note(
		stock,
		`D${verifiedRow}`,
		`Counted again on ${shortDate(month, rng.int(1, 28))}: ${raw(`D${verifiedRow}`)} is correct, leave it.`,
	);
	const currentCents = Math.round(Number(raw(`F${priceRow}`)) * 100);
	const olderCents = Math.max(50, currentCents - rng.int(1, 20) * 25);
	note(
		stock,
		`F${priceRow}`,
		`The price went up from $${amount(olderCents)} to $${amount(currentCents)} in ${MONTHS[month - 2]}; this is current.`,
	);

	const leadRow = rng.int(2, suppliers.length + 1);
	const oldLead = Number(supplierSheet.cells[`C${leadRow}`]);
	const newLead = oldLead + rng.pick([-2, 3, 5, 9]);
	note(supplierSheet, `C${leadRow}`, `Lead time is now ${newLead} days, confirmed by phone.`);
	const minimumRow = rng.pick([2, 3, 4, 5, 6].filter(row => row !== leadRow));
	note(supplierSheet, `D${minimumRow}`, `Minimum order confirmed at ${supplierSheet.cells[`D${minimumRow}`]} units.`);

	const bookName = "Warehouse Stock";
	const book = newWorkbook(rng, bookName, [stock, supplierSheet]);
	return {
		world: worldOf(rng, [book]),
		book,
		plan: {
			bookName,
			corrections: [
				{ sheet: "Stock", cell: `D${hiddenRow}`, value: newCount },
				{ sheet: "Stock", cell: `F${invoiceRow}`, value: invoiceNew / 100 },
				{ sheet: "Stock", cell: `B${bottom}`, value: renamed },
				{ sheet: "Stock", cell: `E${dozenRow}`, value: dozen },
				{ sheet: "Suppliers", cell: `C${leadRow}`, value: newLead },
			],
			kept: [
				{ sheet: "Stock", cell: `D${verifiedRow}` },
				{ sheet: "Stock", cell: `F${priceRow}` },
				{ sheet: "Suppliers", cell: `D${minimumRow}` },
			],
		},
	};
}

function corrected(state: SheetTaskState<FlaggedCells>, correction: Correction | undefined): boolean {
	if (!correction) return false;
	const value = sheetOf(state, correction.sheet)?.values[correction.cell];
	return typeof correction.value === "number"
		? numberNear(value, correction.value, 1e-9)
		: typeof value === "string" && normalizeText(value) === normalizeText(correction.value);
}

const fixFlaggedCells = kitTask<SheetTaskState<FlaggedCells>>({
	id: "sheet-fix-flagged-cells",
	title: "Apply the corrections that cell comments ask for, and only those",
	capabilities: ["inline-edit", "reading", "search-filter", "multi-page"],
	difficulty: "hard",
	timeBudgetSec: 720,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const { world, book, plan } = planFlaggedCells(rng);
		const before = inputsOf(world);
		const site = await startSheetSite(world);
		return {
			instruction: [
				intro(site.origin),
				`In the workbook "${plan.bookName}", reviewers left comments on some cells. A cell with a comment has a small orange mark in its corner; rest the pointer on the cell to read its comment.`,
				"Some comments say what the cell's value should be: apply each of those corrections by entering the corrected value in the commented cell itself. Other comments confirm that a value is right: leave those cells as they are.",
				"Check every sheet and every row of the workbook, and change nothing that no comment asks for.",
				"Reply when you are done.",
			].join("\n"),
			solve: async () => {
				const client = new FormClient(site.origin);
				for (const sheet of ["Stock", "Suppliers"]) {
					await postOk(client, `/api/wb/${book.id}/cells`, {
						sheet,
						edits: plan.corrections
							.filter(correction => correction.sheet === sheet)
							.map(correction => ({ cell: correction.cell, raw: String(correction.value) })),
					});
				}
				return "Applied every correction the comments ask for.";
			},
			finish: async () => ({ ...(await site.finish()), expected: { ...plan, book: book.id, before } }),
		};
	},
	checks: [
		{
			id: "visible-corrections",
			description: "the three Stock corrections in rows the filter shows are applied",
			pass: state => [1, 2, 3].every(index => corrected(state, state.expected.corrections[index])),
		},
		{
			id: "filtered-row-correction",
			description: "the Stock correction in a row the filter hides is applied",
			pass: state => corrected(state, state.expected.corrections[0]),
		},
		{
			id: "suppliers-correction",
			description: "the correction on the Suppliers sheet is applied",
			pass: state => corrected(state, state.expected.corrections[4]),
		},
		{
			id: "confirmed-cells-kept",
			description: "cells whose comment confirms the value are unchanged",
			pass: state =>
				state.expected.kept.every(
					entry =>
						sheetOf(state, entry.sheet)?.cells[entry.cell] ===
						state.expected.before[state.expected.book]?.[entry.sheet]?.[entry.cell],
				),
		},
		{
			id: "nothing-else-changed",
			description: "no cell without a correcting comment changed",
			pass: state =>
				onlyChanged(
					state,
					state.expected.corrections.map(correction =>
						cellKey(state.expected.book, correction.sheet, correction.cell),
					),
				),
		},
	],
});

// ---------------------------------------------------------------------------------------------
// sheet-sort-and-answer

interface SortAnswer {
	readonly bookName: string;
	readonly column: string;
	/** Every data row's inputs, columns A to F, in the sorted order. */
	readonly rows: readonly (readonly string[])[];
	readonly third: string;
}

const PRODUCT_HEADERS = ["SKU", "Product", "Category", "Units sold", "Units returned", "Revenue"];

function planSortAnswer(rng: Seeded): { world: GridWorld; book: Workbook; plan: SortAnswer } {
	for (let attempt = 0; attempt < 100; attempt++) {
		const count = rng.int(22, 30);
		const names = productNames(rng, count);
		const sold = rng.sample(
			Array.from({ length: 921 }, (_, i) => i + 40),
			count,
		);
		const revenues = new Set<number>();
		const rows = names.map((entry, i) => {
			const units = sold[i] as number;
			let revenue = units * rng.int(800, 12000);
			while (revenues.has(revenue)) revenue = units * rng.int(800, 12000);
			revenues.add(revenue);
			return [
				`PR-${rng.code(5)}`,
				entry.name,
				NOUN_CATEGORY[entry.noun] as string,
				String(units),
				String(rng.int(0, 40)),
				plainAmount(revenue),
			];
		});
		const column = rng.pick(["Units sold", "Revenue"]);
		const other = column === "Units sold" ? "Revenue" : "Units sold";
		const key = (row: readonly string[], header: string) => Number(row[PRODUCT_HEADERS.indexOf(header)]);
		const sorted = [...rows].sort((a, b) => key(b, column) - key(a, column));
		const third = sorted[2] as string[];
		const byOther = [...rows].sort((a, b) => key(b, other) - key(a, other));
		const ascending = [...sorted].reverse();
		if (byOther[2] === third || ascending[2] === third) continue;
		const categories = [...new Set(rows.map(row => row[2] as string))];
		const shown = categories.filter(category => category !== third[2]);
		if (shown.length < 2) continue;
		const products = sheetFrom("Products", [PRODUCT_HEADERS, ...rows]);
		products.filters = { C: shown };
		const categorySheet = sheetFrom("Categories", [
			["Category", "Manager", "Target units"],
			...Object.values(NOUN_CATEGORY)
				.filter((category, index, all) => all.indexOf(category) === index)
				.map(category => [category, rng.pick(PEOPLE), rng.int(20, 90) * 100]),
		]);
		const bookName = "Store Performance";
		const book = newWorkbook(rng, bookName, [products, categorySheet]);
		return {
			world: worldOf(rng, [book]),
			book,
			plan: { bookName, column, rows: sorted, third: third[1] as string },
		};
	}
	throw new Error("no product sheet with a unique third row");
}

const sortAndAnswer = kitTask<SheetTaskState<SortAnswer>>({
	id: "sheet-sort-and-answer",
	title: "Sort a filtered sheet from its column menu and report the third row",
	capabilities: ["search-filter", "reading"],
	difficulty: "medium",
	timeBudgetSec: 480,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const { world, book, plan } = planSortAnswer(rng);
		const before = inputsOf(world);
		const site = await startSheetSite(world);
		const sortCol = String.fromCharCode(65 + PRODUCT_HEADERS.indexOf(plan.column));
		return {
			instruction: [
				intro(site.origin),
				`In the workbook "${plan.bookName}", sort the Products sheet by its "${plan.column}" column from largest to smallest, keeping each row's cells together, and make sure no filter hides any rows when you are done.`,
				"Then reply with the name of the product in the third data row (the third row below the header).",
			].join("\n"),
			solve: async () => {
				const client = new FormClient(site.origin);
				await postOk(client, `/api/wb/${book.id}/filter`, { sheet: "Products", col: null, values: null });
				await postOk(client, `/api/wb/${book.id}/sort`, { sheet: "Products", col: sortCol, dir: "desc" });
				return `The third row is ${plan.third}.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: { ...plan, book: book.id, before } }),
		};
	},
	checks: [
		{
			id: "sorted-descending",
			description: "the Products rows are in descending order of the column, each row intact",
			pass: state => {
				const sheet = sheetOf(state, "Products");
				return state.expected.rows.every((row, i) =>
					row.every((raw, c) => (sheet?.cells[`${String.fromCharCode(65 + c)}${i + 2}`] ?? "") === raw),
				);
			},
		},
		{
			id: "no-filter",
			description: "no filter hides rows of the Products sheet",
			pass: state => {
				const sheet = sheetOf(state, "Products");
				return sheet !== undefined && Object.keys(sheet.filters).length === 0;
			},
		},
		{
			id: "answer-third",
			description: "the reply names the product in the third data row",
			pass: (state, answer) => answerHasText(answer, state.expected.third),
		},
		{
			id: "nothing-else-changed",
			description: "no cell outside the sorted rows changed",
			pass: state =>
				changedCells(state, state.expected.before).every(key => {
					const prefix = `${state.expected.book}/Products!`;
					const row = key.startsWith(prefix) ? (parseCellName(key.slice(prefix.length))?.row ?? 0) : 0;
					return row >= 2 && row <= state.expected.rows.length + 1;
				}),
		},
	],
});

// ---------------------------------------------------------------------------------------------
// sheet-cross-sheet-summary

interface RegionRow {
	readonly region: string;
	/** The Summary row that names the region. */
	readonly row: number;
	readonly totalCents: number;
	readonly count: number;
}

interface CrossSheet {
	readonly bookName: string;
	readonly regions: readonly RegionRow[];
	readonly best: string;
	/** The Data sheet's last sale row. */
	readonly lastRow: number;
}

const REGIONS = ["North", "South", "East", "West", "Central"];

function planCrossSheet(rng: Seeded): { world: GridWorld; book: Workbook; plan: CrossSheet } {
	for (let attempt = 0; attempt < 200; attempt++) {
		const sales = REGIONS.flatMap(region =>
			Array.from({ length: rng.int(5, 13) }, () => ({ region, cents: rng.int(12000, 480000) })),
		);
		const stats = REGIONS.map(region => {
			const mine = sales.filter(sale => sale.region === region);
			const totalCents = mine.reduce((sum, sale) => sum + sale.cents, 0);
			return { region, totalCents, count: mine.length, average: totalCents / mine.length };
		});
		const byAverage = [...stats].sort((a, b) => b.average - a.average);
		const byTotal = [...stats].sort((a, b) => b.totalCents - a.totalCents);
		const [top, second] = byAverage as [(typeof stats)[number], (typeof stats)[number]];
		if (top.average - second.average < top.average * 0.02) continue;
		if (byTotal[0]?.region === top.region) continue;
		const reps = Object.fromEntries(REGIONS.map(region => [region, rng.sample(PEOPLE, 2)]));
		const shuffled = rng.shuffle(sales);
		const days = shuffled.map(() => rng.int(1, 91)).sort((a, b) => a - b);
		const lastRow = shuffled.length + 1;
		const data = sheetFrom("Data", [
			["Date", "Region", "Rep", "Amount"],
			...shuffled.map((sale, i) => [
				isoDate(2026, 7, days[i] as number),
				sale.region,
				rng.pick(reps[sale.region] as string[]),
				plainAmount(sale.cents),
			]),
			[],
			["Total", "", "", `=SUM(D2:D${lastRow})`],
		]);
		const order = rng.shuffle(stats);
		const summary = sheetFrom("Summary", [
			["Region", "Total sales", "Average sale"],
			...order.map(stat => [stat.region]),
			[],
			["Prepared by", rng.pick(PEOPLE)],
		]);
		const targets = sheetFrom("Targets", [
			["Region", "Q3 target"],
			...REGIONS.map(region => [region, rng.int(20, 90) * 1000]),
		]);
		const bookName = "Regional Sales Q3";
		const book = newWorkbook(rng, bookName, [summary, data, targets]);
		const regions = order.map((stat, i) => ({
			region: stat.region,
			row: i + 2,
			totalCents: stat.totalCents,
			count: stat.count,
		}));
		return { world: worldOf(rng, [book]), book, plan: { bookName, regions, best: top.region, lastRow } };
	}
	throw new Error("no sales data with a unique best average");
}

function readsData(raw: string | undefined): boolean {
	return (
		raw !== undefined &&
		raw.startsWith("=") &&
		formulaReferences(raw).some(ref => ref.sheet?.toLowerCase() === "data")
	);
}

const crossSheetSummary = kitTask<SheetTaskState<CrossSheet>>({
	id: "sheet-cross-sheet-summary",
	title: "Summarize another sheet per region with cross-sheet formulas",
	capabilities: ["inline-edit", "keyboard", "reasoning", "multi-page"],
	difficulty: "hard",
	timeBudgetSec: 720,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const { world, book, plan } = planCrossSheet(rng);
		const before = inputsOf(world);
		const site = await startSheetSite(world);
		return {
			instruction: [
				intro(site.origin),
				`The workbook "${plan.bookName}" has a Data sheet listing every sale and a Summary sheet with one row per region.`,
				`On the Summary sheet, fill in the "Total sales" and "Average sale" columns for every region with formulas that compute them from the Data sheet: the sum and the average of that region's Amount values. Do not change the Data sheet.`,
				"Then reply with the name of the region that has the highest average sale.",
			].join("\n"),
			solve: async () => {
				const client = new FormClient(site.origin);
				const range = (col: string) => `Data!$${col}$2:$${col}$${plan.lastRow}`;
				await postOk(client, `/api/wb/${book.id}/cells`, {
					sheet: "Summary",
					edits: plan.regions.flatMap(entry => [
						{ cell: `B${entry.row}`, raw: `=SUMIF(${range("B")},A${entry.row},${range("D")})` },
						{ cell: `C${entry.row}`, raw: `=AVERAGEIF(${range("B")},A${entry.row},${range("D")})` },
					]),
				});
				return `${plan.best} has the highest average sale.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: { ...plan, book: book.id, before } }),
		};
	},
	checks: [
		{
			id: "formulas-read-data",
			description: "every Total sales and Average sale cell is a formula that reads the Data sheet",
			pass: state => {
				const sheet = sheetOf(state, "Summary");
				return state.expected.regions.every(
					entry => readsData(sheet?.cells[`B${entry.row}`]) && readsData(sheet?.cells[`C${entry.row}`]),
				);
			},
		},
		{
			id: "totals-exact",
			description: "every region's Total sales is the sum of its amounts",
			pass: state => {
				const sheet = sheetOf(state, "Summary");
				return state.expected.regions.every(entry =>
					numberNear(sheet?.values[`B${entry.row}`], entry.totalCents / 100, 0.001),
				);
			},
		},
		{
			id: "averages-exact",
			description: "every region's Average sale is the mean of its amounts",
			pass: state => {
				const sheet = sheetOf(state, "Summary");
				return state.expected.regions.every(entry =>
					numberNear(sheet?.values[`C${entry.row}`], entry.totalCents / entry.count / 100, 0.005),
				);
			},
		},
		{
			id: "answer-best-average",
			description: "the reply names the region with the highest average sale",
			pass: (state, answer) => answerHasText(answer, state.expected.best),
		},
		{
			id: "nothing-else-changed",
			description: "only the Summary's Total sales and Average sale cells changed",
			pass: state =>
				onlyChanged(
					state,
					state.expected.regions.flatMap(entry => [
						cellKey(state.expected.book, "Summary", `B${entry.row}`),
						cellKey(state.expected.book, "Summary", `C${entry.row}`),
					]),
				),
		},
	],
});

// ---------------------------------------------------------------------------------------------
// sheet-reconcile-ledger

interface Reconcile {
	readonly bookName: string;
	/** The Ledger's last data row. */
	readonly lastRow: number;
	/** Ledger rows with no matching bank transaction. */
	readonly missingRows: readonly number[];
	/** Every ledger amount minus the bank's credits minus debits. */
	readonly netCents: number;
}

interface LedgerEntry {
	readonly day: number;
	readonly cents: number;
	readonly payee: string;
	readonly missing: boolean;
}

interface BankEntry {
	readonly day: number;
	readonly cents: number;
	readonly description: string;
}

const PAYEES = [
	"Greenleaf Market",
	"City Water Utility",
	"Metro Power & Light",
	"Sparrow Office Supply",
	"Harbor Freight Lines",
	"Northside Rent LLC",
	"Brightline Internet",
	"Juniper Catering",
	"Atlas Insurance",
	"Parkway Fuel",
	"Ledgerly Software",
	"Canopy Cleaning",
];

function bankDescription(rng: Seeded, payee: string, deposit: boolean): string {
	const name = payee
		.toUpperCase()
		.replaceAll(/[^A-Z0-9 ]/g, "")
		.slice(0, 16)
		.trim();
	return deposit ? `DEPOSIT ${name}` : `${rng.pick(["POS", "ACH DEBIT", "CARD"])} ${name} ${rng.int(1000, 9999)}`;
}

/** Cents with one pair of adjacent differing digits swapped, `45.10` to `45.01`, never moving a 0 to the front. */
function transposed(rng: Seeded, cents: number): number | null {
	const digits = String(Math.abs(cents)).split("");
	const pairs = digits.flatMap((digit, i) => {
		const next = digits[i + 1];
		return next !== undefined && digit !== next && !(i === 0 && next === "0") ? [i] : [];
	});
	if (pairs.length === 0) return null;
	const at = rng.pick(pairs);
	[digits[at], digits[at + 1]] = [digits[at + 1] as string, digits[at] as string];
	return Math.sign(cents) * Number(digits.join(""));
}

function matches(ledger: LedgerEntry, bank: BankEntry): boolean {
	return ledger.cents === bank.cents && Math.abs(ledger.day - bank.day) <= 1;
}

function planReconcile(rng: Seeded): { world: GridWorld; book: Workbook; plan: Reconcile } {
	const year = 2026;
	for (let attempt = 0; attempt < 200; attempt++) {
		const month = rng.int(2, 10);
		const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
		const used = new Set<number>();
		const fresh = (min: number, max: number) => {
			for (;;) {
				const cents = rng.int(min, max);
				if (!used.has(cents)) {
					used.add(cents);
					return cents;
				}
			}
		};
		const ledger: LedgerEntry[] = [];
		const bank: BankEntry[] = [];
		const payment = () => {
			const deposit = rng.next() < 0.2;
			const payee = deposit ? `Client payment ${rng.pick(COMPANIES)}` : rng.pick(PAYEES);
			const cents = deposit ? fresh(20000, 900000) : -fresh(450, 240000);
			return { payee, cents, deposit };
		};
		const matched = (day: number) => {
			const entry = payment();
			ledger.push({ day, cents: entry.cents, payee: entry.payee, missing: false });
			bank.push({
				day: day + rng.pick([-1, 0, 0, 0, 1, 1]),
				cents: entry.cents,
				description: bankDescription(rng, entry.payee, entry.deposit),
			});
			return entry;
		};
		for (let i = rng.int(20, 25); i > 0; i--) matched(rng.int(2, days - 1));
		// Two entries the bank never saw.
		for (let i = 0; i < 2; i++) {
			const entry = payment();
			ledger.push({ day: rng.int(1, days), cents: entry.cents, payee: entry.payee, missing: true });
		}
		// The same amount at the bank, but too many days away.
		const lateDay = rng.int(5, days - 5);
		const late = payment();
		ledger.push({ day: lateDay, cents: late.cents, payee: late.payee, missing: true });
		bank.push({
			day: lateDay + rng.pick([-4, -3, -2, 2, 3, 4]),
			cents: late.cents,
			description: bankDescription(rng, late.payee, late.deposit),
		});
		// The right day at the bank, but two digits of the amount swapped.
		const typoDay = rng.int(2, days - 1);
		const typo = payment();
		const swapped = transposed(rng, typo.cents);
		if (swapped === null || used.has(Math.abs(swapped))) continue;
		used.add(Math.abs(swapped));
		ledger.push({ day: typoDay, cents: typo.cents, payee: typo.payee, missing: true });
		bank.push({
			day: typoDay + rng.pick([0, 1]),
			cents: swapped,
			description: bankDescription(rng, typo.payee, typo.deposit),
		});
		// A recurring charge whose second occurrence never reached the bank.
		const firstDay = rng.int(2, days - 14);
		const recurring = matched(firstDay);
		ledger.push({ day: firstDay + rng.int(7, 12), cents: recurring.cents, payee: recurring.payee, missing: true });
		// Bank-only lines.
		bank.push({ day: rng.int(25, days), cents: -fresh(1000, 2500), description: "MONTHLY SERVICE FEE" });
		bank.push({ day: days, cents: fresh(10, 399), description: "INTEREST PAID" });

		const ambiguous = ledger.some(entry => {
			const count = bank.filter(line => matches(entry, line)).length;
			return count > 1 || (count === 0) !== entry.missing;
		});
		if (ambiguous || bank.some(line => ledger.filter(entry => matches(entry, line)).length > 1)) continue;
		const netCents =
			ledger.reduce((sum, entry) => sum + entry.cents, 0) - bank.reduce((sum, line) => sum + line.cents, 0);
		if (netCents === 0) continue;

		// The ledger in entry order: by date, with a few entries keyed in late.
		const byDay = [...ledger].sort((a, b) => a.day - b.day);
		const keyedLate = rng.sample(byDay.slice(0, -3), 2);
		const entries = [...byDay.filter(entry => !keyedLate.includes(entry)), ...keyedLate];
		const bankLines = [...bank].sort((a, b) => a.day - b.day || a.description.localeCompare(b.description));
		const mmdd = (day: number) => {
			const date = isoDate(year, month, day);
			return `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;
		};
		const bankSheet = sheetFrom("Bank", [
			["Date", "Description", "Debit", "Credit"],
			...bankLines.map(line => [
				mmdd(line.day),
				line.description,
				line.cents < 0 ? plainAmount(-line.cents) : "",
				line.cents > 0 ? plainAmount(line.cents) : "",
			]),
		]);
		const ledgerSheet = sheetFrom("Ledger", [
			["Date", "Payee", "Amount", "Status"],
			...entries.map(entry => [isoDate(year, month, entry.day), entry.payee, plainAmount(entry.cents), ""]),
		]);
		const bookName = `${MONTHS[month - 1]} Reconciliation`;
		const book = newWorkbook(rng, bookName, [bankSheet, ledgerSheet]);
		return {
			world: worldOf(rng, [book]),
			book,
			plan: {
				bookName,
				lastRow: entries.length + 1,
				missingRows: entries.flatMap((entry, i) => (entry.missing ? [i + 2] : [])),
				netCents,
			},
		};
	}
	throw new Error("no ledger with an unambiguous reconciliation");
}

/** Whether the answer states `expected` with its sign, written `-12.30`, `-$12.30`, `−12.30` or `($12.30)`. */
function answerHasSignedAmount(answer: string, expected: number): boolean {
	const normalized = answer
		.replaceAll(/[\u2212\u2013]/g, "-")
		.replaceAll(/-\s*\$\s*/g, "-")
		.replaceAll(/\$\s*-/g, "-")
		.replaceAll(/\(\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\s*\)/g, "-$1");
	return answerHasNumber(normalized, expected);
}

const reconcileLedger = kitTask<SheetTaskState<Reconcile>>({
	id: "sheet-reconcile-ledger",
	title: "Reconcile a ledger against a bank export and mark the missing rows",
	capabilities: ["inline-edit", "reasoning", "reading", "multi-page"],
	difficulty: "expert",
	timeBudgetSec: 900,
	async start({ seed }) {
		const rng = new Seeded(seed);
		const { world, book, plan } = planReconcile(rng);
		const before = inputsOf(world);
		const site = await startSheetSite(world);
		return {
			instruction: [
				intro(site.origin),
				`The workbook "${plan.bookName}" holds a Bank sheet (the bank's export of the account) and a Ledger sheet (the company's own records of it).`,
				"A ledger row is matched when the bank has a transaction of exactly the same amount dated the same day or one day before or after it. A payment (a negative ledger amount) appears in the bank's Debit column and a deposit (a positive one) in its Credit column. Each bank transaction matches at most one ledger row.",
				"In the Ledger's Status column, write MISSING for every ledger row that has no matching bank transaction, and leave Status empty for every row that has one. Change nothing else.",
				"Then reply with the net difference: the sum of all ledger amounts minus the bank's net (all credits minus all debits), as a signed number.",
			].join("\n"),
			solve: async () => {
				const client = new FormClient(site.origin);
				await postOk(client, `/api/wb/${book.id}/cells`, {
					sheet: "Ledger",
					edits: plan.missingRows.map(row => ({ cell: `D${row}`, raw: "MISSING" })),
				});
				return `The net difference is ${plainAmount(plan.netCents)}.`;
			},
			finish: async () => ({ ...(await site.finish()), expected: { ...plan, book: book.id, before } }),
		};
	},
	checks: [
		{
			id: "missing-rows-marked",
			description: "every ledger row without a matching bank transaction says MISSING",
			pass: state => {
				const sheet = sheetOf(state, "Ledger");
				return state.expected.missingRows.every(row => normalizeText(sheet?.cells[`D${row}`] ?? "") === "missing");
			},
		},
		{
			id: "matched-rows-blank",
			description: "every matched ledger row's Status is empty",
			pass: state => {
				const sheet = sheetOf(state, "Ledger");
				return dataRows(state.expected)
					.filter(row => !state.expected.missingRows.includes(row))
					.every(row => (sheet?.cells[`D${row}`] ?? "") === "");
			},
		},
		{
			id: "nothing-else-changed",
			description: "only the Ledger's Status cells changed",
			pass: state =>
				onlyChanged(
					state,
					dataRows(state.expected).map(row => cellKey(state.expected.book, "Ledger", `D${row}`)),
				),
		},
		{
			id: "answer-net",
			description: "the reply states the signed net difference",
			pass: (state, answer) => answerHasSignedAmount(answer, state.expected.netCents / 100),
		},
	],
});

export const SHEET_TASKS: readonly KitTask[] = [
	fillLineTotals,
	fixFlaggedCells,
	sortAndAnswer,
	crossSheetSummary,
	reconcileLedger,
];
