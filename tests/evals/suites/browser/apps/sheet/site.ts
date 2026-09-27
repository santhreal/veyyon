/**
 * Gridwork's pages and endpoints over one {@link GridWorld}.
 *
 * What makes it hard to operate is how spreadsheets work: the grid is rows of `div`s, not inputs, so
 * a value is entered by selecting a cell and typing (Enter commits and moves down, Tab moves right,
 * Escape cancels) or through the formula bar; a range is selected by shift-click or drag; a formula
 * is filled down with Ctrl+D or the drag handle; sorting and filtering live in a column header menu;
 * comments show only while the pointer rests on a cell; a filter hides rows until it is cleared. The
 * server stores each cell's raw input and evaluates every formula, and every edit posts to it.
 */

import {
	escapeHtml,
	type HostedSite,
	hostSite,
	html,
	json,
	jsonBody,
	redirect,
	type SiteRequest,
	type SiteResponse,
	text,
} from "../../../../engine/kit/web-host";
import { page } from "../../ui";
import {
	evaluatorFor,
	fillRect,
	findSheet,
	findWorkbook,
	type GridWorld,
	hiddenRows,
	type Sheet,
	type SortDirection,
	setCell,
	sheetCsv,
	sheetValues,
	shownText,
	sortRows,
	usedBounds,
	type Workbook,
} from "./data";
import {
	type CellValue,
	cellName,
	columnIndex,
	columnLetter,
	FUNCTION_NAMES,
	isError,
	MAX_COLS,
	MAX_ROWS,
	parseCellName,
	parseRect,
} from "./formula";

export interface SheetState {
	readonly name: string;
	/** Raw inputs by address. */
	readonly cells: Readonly<Record<string, string>>;
	/** The evaluated value of every non-empty cell. */
	readonly values: Readonly<Record<string, CellValue>>;
	readonly filters: Readonly<Record<string, readonly string[]>>;
}

export interface WorkbookState {
	readonly id: string;
	readonly name: string;
	readonly sheets: readonly SheetState[];
}

export interface GridSnapshot {
	readonly workbooks: readonly WorkbookState[];
	/** Edit, fill, sort and filter requests the server applied. */
	readonly changes: number;
}

export interface GridSite extends HostedSite {
	finish(): Promise<GridSnapshot>;
}

/** The longest raw input a cell stores. */
const MAX_INPUT = 2000;

const STYLE = `
[hidden]{display:none !important}
main{max-width:1180px}
.books td a{font-weight:600}
.toolbar{display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
.toolbar h1{font-size:18px;margin:0;flex:1}
#save-status{color:#6b7280;font-size:12px;min-width:120px;text-align:right}
.fn-help{position:relative;font-size:13px}
.fn-help div{position:absolute;right:0;top:24px;z-index:25;background:#fff;border:1px solid #cbd5e1;border-radius:6px;padding:8px 12px;width:320px}
.formula-row{display:flex;gap:6px;align-items:center;background:#fff;border:1px solid #d1d5db;border-bottom:0;padding:3px 6px}
#name-box{width:86px;font:12px ui-monospace,monospace;border-right:1px solid #e5e7eb;padding-right:6px}
.fx{color:#6b7280;font-style:italic;font-family:serif}
#formula-input{flex:1;border:0;font:13px ui-monospace,monospace;padding:3px}
#formula-input:focus{outline:1px solid #93c5fd}
.filter-banner{background:#eff6ff;border:1px solid #bfdbfe;padding:6px 10px;margin-bottom:6px;display:flex;gap:10px;align-items:center;font-size:13px}
.grid-wrap{overflow:auto;max-height:calc(100vh - 270px);min-height:240px;border:1px solid #d1d5db;background:#fff}
#grid{position:relative;display:inline-block;min-width:100%;outline:none;user-select:none}
.grow{display:flex}
.grow.head{position:sticky;top:0;z-index:3}
.corner,.rh,.ch{background:#f3f4f6;color:#4b5563;font-size:12px;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;flex:none}
.corner{width:46px;position:sticky;left:0;z-index:4}
.rh{width:46px;text-align:center;position:sticky;left:0;z-index:2;line-height:25px}
.ch{width:112px;height:26px;display:flex;align-items:center;justify-content:center;gap:4px}
.ch.filtered{background:#dbeafe;color:#1d4ed8}
.col-menu{background:none;color:#374151;padding:0 5px;font-size:11px;border-radius:3px}
.col-menu:hover{background:#e5e7eb}
.cell{width:112px;flex:none;height:26px;line-height:25px;padding:0 5px;border-right:1px solid #eef0f3;border-bottom:1px solid #eef0f3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:cell;position:relative;font-size:13px}
.cell.num{text-align:right}
.cell.err{color:#b91c1c}
.cell.in-range{background:#e8f0fe}
.cell.active{outline:2px solid #1a73e8;outline-offset:-2px}
.cell.editing{background:#fff;outline:2px solid #1a73e8;outline-offset:-2px;overflow:visible;text-overflow:clip;cursor:text;z-index:5;user-select:text;text-align:left}
.cell.fill-preview{outline:1px dashed #1a73e8;outline-offset:-2px}
.cell.has-comment::after{content:"";position:absolute;top:0;right:0;border-top:7px solid #ea580c;border-left:7px solid transparent}
#fill-handle{position:absolute;width:8px;height:8px;background:#1a73e8;border:1px solid #fff;cursor:crosshair;z-index:6}
.tabs{display:flex;gap:2px;background:#f3f4f6;border:1px solid #d1d5db;border-top:0;padding:0 6px}
.tabs a{padding:6px 16px;color:#374151;text-decoration:none;font-size:13px}
.tabs a[aria-current=page]{background:#fff;color:#1a73e8;font-weight:600;box-shadow:inset 0 2px 0 #1a73e8}
.popup{position:absolute;background:#fff;border:1px solid #cbd5e1;border-radius:6px;box-shadow:0 6px 18px rgba(15,23,42,.18);z-index:20}
#col-menu{padding:4px 0;min-width:200px}
#col-menu [role=menuitem]{display:block;width:100%;text-align:left;background:none;color:#111827;border-radius:0;padding:6px 12px}
#col-menu [role=menuitem]:hover{background:#f3f4f6}
#filter-pop{padding:10px;width:240px}
#filter-pop .values{max-height:220px;overflow:auto;margin:6px 0}
#filter-pop label{display:flex;gap:6px;align-items:center;margin:2px 0}
#comment-pop{position:fixed;background:#fffbeb;border:1px solid #f59e0b;border-radius:4px;padding:6px 9px;max-width:280px;font-size:12px;z-index:30;box-shadow:0 4px 12px rgba(0,0,0,.15);pointer-events:none}
`;

const SHEET_SCRIPT = `
(() => {
const cfg = JSON.parse(document.getElementById("sheet-data").textContent);
const grid = document.getElementById("grid");
const bar = document.getElementById("formula-input");
const nameBox = document.getElementById("name-box");
const saveStatus = document.getElementById("save-status");
const handle = document.getElementById("fill-handle");
const menu = document.getElementById("col-menu");
const filterPop = document.getElementById("filter-pop");
const commentPop = document.getElementById("comment-pop");
const api = "/api/wb/" + cfg.book;
let cells = cfg.cells;
const letter = i => { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const name = (c, r) => letter(c) + r;
const parse = a => { const m = /^([A-Z]+)([0-9]+)$/.exec(a); let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; return { c: c - 1, r: Number(m[2]) }; };
const cellAt = (c, r) => grid.querySelector('[data-cell="' + name(c, r) + '"]');
const visible = r => { const row = grid.querySelector('.grow[data-row="' + r + '"]'); return row !== null && !row.hidden; };
const rawAt = (c, r) => (cells[name(c, r)] || {}).raw || "";
let active = { c: 0, r: 1 };
let extent = { c: 0, r: 1 };
let tabStart = null;
let editing = null;
let dragging = false;
let fillDrag = null;
let barCell = null;
let menuCol = null;
const rect = () => ({ c1: Math.min(active.c, extent.c), r1: Math.min(active.r, extent.r), c2: Math.max(active.c, extent.c), r2: Math.max(active.r, extent.r) });
const rectName = R => R.c1 === R.c2 && R.r1 === R.r2 ? name(R.c1, R.r1) : name(R.c1, R.r1) + ":" + name(R.c2, R.r2);

function paint() {
	for (const node of grid.querySelectorAll(".cell.in-range, .cell.active")) node.classList.remove("in-range", "active");
	const R = rect();
	for (let r = R.r1; r <= R.r2; r++) for (let c = R.c1; c <= R.c2; c++) { const node = cellAt(c, r); if (node) node.classList.add("in-range"); }
	const current = cellAt(active.c, active.r);
	if (current) current.classList.add("active");
	nameBox.textContent = rectName(R);
	if (document.activeElement !== bar) bar.value = rawAt(active.c, active.r);
	const corner = cellAt(R.c2, R.r2);
	if (corner && visible(R.r2)) {
		handle.hidden = false;
		handle.style.left = (corner.offsetLeft + corner.offsetWidth - 5) + "px";
		handle.style.top = (corner.offsetTop + corner.offsetHeight - 5) + "px";
	} else handle.hidden = true;
}

function step(r, dr) {
	let n = r;
	do { n += dr; } while (n >= 1 && n <= cfg.rows && !visible(n));
	return n < 1 || n > cfg.rows ? r : n;
}

function move(dc, dr, extend) {
	const from = extend ? extent : active;
	const next = { c: Math.max(0, Math.min(cfg.cols - 1, from.c + dc)), r: dr === 0 ? from.r : step(from.r, dr) };
	if (extend) extent = next; else { active = next; extent = next; }
	paint();
	const node = cellAt(next.c, next.r);
	if (node) node.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function renderCell(node) {
	if (editing && editing.node === node) return;
	const data = cells[node.dataset.cell];
	node.textContent = data ? data.display : "";
	node.classList.toggle("num", !!data && data.kind === "num");
	node.classList.toggle("err", !!data && data.kind === "err");
}

function renderAll() {
	for (const node of grid.querySelectorAll(".cell")) renderCell(node);
	if (document.activeElement !== bar) bar.value = rawAt(active.c, active.r);
}

let queue = Promise.resolve(true);
let pending = 0;
let failure = "";
function send(path, body) {
	pending++;
	saveStatus.textContent = "Saving…";
	const job = queue.then(async () => {
		try {
			const response = await fetch(api + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ sheet: cfg.sheet }, body)) });
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));
			failure = "";
			if (data.cells) { cells = data.cells; renderAll(); }
			return true;
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
			return false;
		} finally {
			pending--;
			saveStatus.textContent = failure ? "Not saved: " + failure : pending > 0 ? "Saving…" : "All changes saved";
		}
	});
	queue = job;
	return job;
}

function save(edits) {
	for (const edit of edits) {
		cells[edit.cell] = { raw: edit.raw, display: edit.raw, kind: "text" };
		const node = grid.querySelector('[data-cell="' + edit.cell + '"]');
		if (node) renderCell(node);
	}
	return send("/cells", { edits });
}

function startEdit(initial, mode) {
	const node = cellAt(active.c, active.r);
	if (!node) return;
	hideMenus();
	extent = { c: active.c, r: active.r };
	paint();
	editing = { c: active.c, r: active.r, node, mode };
	node.classList.add("editing");
	node.contentEditable = "plaintext-only";
	node.textContent = initial;
	node.focus({ preventScroll: true });
	const range = document.createRange();
	range.selectNodeContents(node);
	range.collapse(false);
	const selection = window.getSelection();
	selection.removeAllRanges();
	selection.addRange(range);
	bar.value = initial;
}

function stopEdit(commit, refocus) {
	const edit = editing;
	if (!edit) return;
	editing = null;
	const typed = edit.node.textContent;
	edit.node.removeAttribute("contenteditable");
	edit.node.classList.remove("editing");
	if (commit && typed !== rawAt(edit.c, edit.r)) save([{ cell: name(edit.c, edit.r), raw: typed }]);
	else renderCell(edit.node);
	if (refocus) grid.focus({ preventScroll: true });
}

function enterMove(up) {
	if (tabStart !== null && !up) { active = { c: tabStart, r: active.r }; extent = active; }
	tabStart = null;
	move(0, up ? -1 : 1, false);
}

function tabMove(back) {
	if (tabStart === null) tabStart = active.c;
	move(back ? -1 : 1, 0, false);
}

const ARROWS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

function fillDown() {
	const R = rect();
	let source;
	let target = R;
	if (R.r2 > R.r1) source = { c1: R.c1, r1: R.r1, c2: R.c2, r2: R.r1 };
	else if (R.r1 > 1) { source = { c1: R.c1, r1: R.r1 - 1, c2: R.c2, r2: R.r1 - 1 }; target = { c1: R.c1, r1: R.r1 - 1, c2: R.c2, r2: R.r2 }; }
	else return;
	send("/fill", { source: rectName(source), target: rectName(target) });
}

function clearRange() {
	const R = rect();
	const edits = [];
	for (let r = R.r1; r <= R.r2; r++) for (let c = R.c1; c <= R.c2; c++) if (rawAt(c, r) !== "") edits.push({ cell: name(c, r), raw: "" });
	if (edits.length) save(edits);
}

grid.addEventListener("keydown", e => {
	if (editing) {
		if (e.key === "Enter" && !e.altKey) { e.preventDefault(); stopEdit(true, true); enterMove(e.shiftKey); }
		else if (e.key === "Tab") { e.preventDefault(); stopEdit(true, true); tabMove(e.shiftKey); }
		else if (e.key === "Escape") { e.preventDefault(); stopEdit(false, true); }
		else if (editing.mode === "enter" && ARROWS[e.key]) { e.preventDefault(); stopEdit(true, true); tabStart = null; move(ARROWS[e.key][0], ARROWS[e.key][1], false); }
		return;
	}
	const mod = e.ctrlKey || e.metaKey;
	if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); fillDown(); return; }
	if (mod || e.altKey) return;
	if (ARROWS[e.key]) { e.preventDefault(); if (!e.shiftKey) tabStart = null; move(ARROWS[e.key][0], ARROWS[e.key][1], e.shiftKey); return; }
	if (e.key === "Enter") { e.preventDefault(); enterMove(e.shiftKey); return; }
	if (e.key === "Tab") { e.preventDefault(); tabMove(e.shiftKey); return; }
	if (e.key === "F2") { e.preventDefault(); startEdit(rawAt(active.c, active.r), "edit"); return; }
	if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); clearRange(); return; }
	if (e.key === "Escape") { hideMenus(); return; }
	if (e.key.length === 1) { e.preventDefault(); startEdit(e.key, "enter"); }
});

grid.addEventListener("input", () => { if (editing) bar.value = editing.node.textContent; });
grid.addEventListener("focusout", e => { if (editing && e.target === editing.node) stopEdit(true, false); });

grid.addEventListener("mousedown", e => {
	if (e.button !== 0) return;
	const node = e.target.closest(".cell");
	if (!node) return;
	if (editing && editing.node === node) return;
	e.preventDefault();
	hideMenus();
	if (editing) stopEdit(true, false);
	tabStart = null;
	const p = parse(node.dataset.cell);
	if (e.shiftKey) extent = p; else { active = p; extent = p; dragging = true; }
	paint();
	grid.focus({ preventScroll: true });
});

grid.addEventListener("dblclick", e => {
	const node = e.target.closest(".cell");
	if (!node || editing) return;
	const p = parse(node.dataset.cell);
	active = p;
	extent = p;
	startEdit(rawAt(p.c, p.r), "edit");
});

function previewFill(p) {
	for (const node of grid.querySelectorAll(".fill-preview")) node.classList.remove("fill-preview");
	const R = fillDrag.from;
	let to = null;
	if (p.r > R.r2 && p.r - R.r2 >= p.c - R.c2) to = { c1: R.c1, r1: R.r1, c2: R.c2, r2: p.r };
	else if (p.c > R.c2) to = { c1: R.c1, r1: R.r1, c2: p.c, r2: R.r2 };
	fillDrag.to = to;
	if (!to) return;
	for (let r = to.r1; r <= to.r2; r++) for (let c = to.c1; c <= to.c2; c++) {
		if (r <= R.r2 && c <= R.c2) continue;
		const node = cellAt(c, r);
		if (node) node.classList.add("fill-preview");
	}
}

handle.addEventListener("mousedown", e => {
	if (e.button !== 0) return;
	e.preventDefault();
	e.stopPropagation();
	if (editing) stopEdit(true, false);
	fillDrag = { from: rect(), to: null };
});

let hoverTimer = 0;
let hoverNode = null;
grid.addEventListener("mouseover", e => {
	const node = e.target.closest(".cell");
	if (node && fillDrag) previewFill(parse(node.dataset.cell));
	else if (node && dragging) { extent = parse(node.dataset.cell); paint(); }
	const commented = node && node.classList.contains("has-comment") ? node : null;
	if (commented === hoverNode) return;
	hoverNode = commented;
	clearTimeout(hoverTimer);
	commentPop.hidden = true;
	if (commented) hoverTimer = setTimeout(() => showComment(commented), 250);
});
grid.addEventListener("mouseleave", () => { hoverNode = null; clearTimeout(hoverTimer); commentPop.hidden = true; });

async function showComment(node) {
	const response = await fetch(api + "/comment?sheet=" + encodeURIComponent(cfg.sheet) + "&cell=" + node.dataset.cell);
	if (!response.ok || hoverNode !== node) return;
	const data = await response.json();
	const who = document.createElement("strong");
	who.textContent = data.author;
	const body = document.createElement("div");
	body.textContent = data.text;
	commentPop.replaceChildren(who, body);
	commentPop.hidden = false;
	const box = node.getBoundingClientRect();
	const width = commentPop.offsetWidth;
	const left = box.right + 6 + width <= window.innerWidth ? box.right + 6 : Math.max(4, box.left - 6 - width);
	commentPop.style.left = left + "px";
	commentPop.style.top = box.top + "px";
}

document.addEventListener("mouseup", () => {
	dragging = false;
	if (!fillDrag) return;
	const drag = fillDrag;
	fillDrag = null;
	for (const node of grid.querySelectorAll(".fill-preview")) node.classList.remove("fill-preview");
	if (!drag.to) return;
	active = { c: drag.to.c1, r: drag.to.r1 };
	extent = { c: drag.to.c2, r: drag.to.r2 };
	paint();
	send("/fill", { source: rectName(drag.from), target: rectName(drag.to) });
});

function commitBar() {
	const target = barCell;
	barCell = null;
	if (target && bar.value !== rawAt(target.c, target.r)) save([{ cell: name(target.c, target.r), raw: bar.value }]);
}
bar.addEventListener("focus", () => { if (editing) stopEdit(true, false); barCell = { c: active.c, r: active.r }; });
bar.addEventListener("keydown", e => {
	if (e.key === "Enter" || e.key === "Tab") {
		e.preventDefault();
		commitBar();
		move(e.key === "Tab" ? 1 : 0, e.key === "Enter" ? 1 : 0, false);
		grid.focus({ preventScroll: true });
	} else if (e.key === "Escape") {
		e.preventDefault();
		barCell = null;
		bar.value = rawAt(active.c, active.r);
		grid.focus({ preventScroll: true });
	}
});
bar.addEventListener("blur", commitBar);

function hideMenus() { menu.hidden = true; filterPop.hidden = true; menuCol = null; }

function placeBelow(popup, anchor) {
	const box = anchor.getBoundingClientRect();
	popup.style.left = (box.left + window.scrollX) + "px";
	popup.style.top = (box.bottom + window.scrollY + 2) + "px";
}

for (const button of document.querySelectorAll(".col-menu")) {
	button.addEventListener("mousedown", e => e.stopPropagation());
	button.addEventListener("click", e => {
		e.stopPropagation();
		const col = button.dataset.col;
		const reopen = !menu.hidden && menuCol === col;
		hideMenus();
		if (reopen) return;
		menuCol = col;
		menu.querySelector('[data-action="clear"]').hidden = !(col in cfg.filters);
		menu.querySelector(".menu-title").textContent = "Column " + col + (cfg.headers[col] ? " · " + cfg.headers[col] : "");
		placeBelow(menu, button);
		menu.hidden = false;
	});
}

menu.addEventListener("click", async e => {
	const item = e.target.closest("[data-action]");
	if (!item || menuCol === null) return;
	const col = menuCol;
	const action = item.dataset.action;
	if (action === "filter") { openFilter(col); return; }
	hideMenus();
	if (action === "asc" || action === "desc") { if (await send("/sort", { col, dir: action })) location.reload(); }
	else if (action === "clear") { if (await send("/filter", { col, values: null })) location.reload(); }
});

function openFilter(col) {
	menu.hidden = true;
	const seen = new Set();
	for (let r = 2; r <= cfg.lastRow; r++) seen.add((cells[col + r] || {}).display || "");
	const values = [...seen].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	const shown = cfg.filters[col];
	const title = document.createElement("strong");
	title.textContent = "Show rows where column " + col + " is:";
	const list = document.createElement("div");
	list.className = "values";
	for (const value of values) {
		const label = document.createElement("label");
		const box = document.createElement("input");
		box.type = "checkbox";
		box.value = value;
		box.checked = !shown || shown.includes(value);
		label.append(box, document.createTextNode(value === "" ? "(Blanks)" : value));
		list.append(label);
	}
	const row = document.createElement("div");
	row.className = "row";
	const apply = document.createElement("button");
	apply.type = "button";
	apply.textContent = "Apply";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "secondary";
	cancel.textContent = "Cancel";
	row.append(apply, cancel);
	filterPop.replaceChildren(title, list, row);
	cancel.addEventListener("click", hideMenus);
	apply.addEventListener("click", async () => {
		const boxes = [...list.querySelectorAll("input")];
		const checked = boxes.filter(box => box.checked).map(box => box.value);
		hideMenus();
		if (await send("/filter", { col, values: checked.length === boxes.length ? null : checked })) location.reload();
	});
	placeBelow(filterPop, grid.querySelector('.ch[data-col="' + col + '"]'));
	filterPop.hidden = false;
}

const clearAll = document.getElementById("clear-filters");
if (clearAll) clearAll.addEventListener("click", async () => { if (await send("/filter", { col: null, values: null })) location.reload(); });

document.addEventListener("mousedown", e => {
	if (menu.contains(e.target) || filterPop.contains(e.target)) return;
	hideMenus();
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && !editing) hideMenus(); });

paint();
grid.focus({ preventScroll: true });
})();
`;

interface CellPayload {
	readonly raw: string;
	readonly display: string;
	readonly kind: "num" | "text" | "bool" | "err";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindOf(value: CellValue | null): CellPayload["kind"] {
	if (typeof value === "number") return "num";
	if (typeof value === "boolean") return "bool";
	return isError(value) ? "err" : "text";
}

/** Every non-empty cell of a sheet with what it shows, as the page's script holds them. */
function cellPayload(book: Workbook, sheet: Sheet): Record<string, CellPayload> {
	const evaluator = evaluatorFor(book);
	const out: Record<string, CellPayload> = {};
	for (const [name, raw] of Object.entries(sheet.cells)) {
		const value = evaluator.value(sheet.name, name);
		out[name] = { raw, display: shownText(raw, value), kind: kindOf(value) };
	}
	return out;
}

function sheetUrl(book: Workbook, sheet: Sheet): string {
	return `/wb/${book.id}?sheet=${encodeURIComponent(sheet.name)}`;
}

export async function startSheetSite(world: GridWorld): Promise<GridSite> {
	let changes = 0;

	const render = (title: string, body: string, script = ""): SiteResponse =>
		html(
			page(title, body, {
				brand: "Gridwork",
				nav: `<a href="/">All workbooks</a><span style="margin-left:auto" class="muted">${escapeHtml(world.user)}</span>`,
				style: STYLE,
				script,
			}),
		);

	const home = () =>
		render(
			"Gridwork",
			`<h1>Workbooks</h1>
<table class="books card">
<thead><tr><th>Name</th><th>Sheets</th><th>Owner</th><th>Last edited</th></tr></thead>
<tbody>${world.workbooks
				.map(
					book =>
						`<tr><td><a href="/wb/${book.id}">${escapeHtml(book.name)}</a></td><td>${book.sheets
							.map(sheet => escapeHtml(sheet.name))
							.join(", ")}</td><td>${escapeHtml(book.owner)}</td><td>${book.edited}</td></tr>`,
				)
				.join("")}</tbody>
</table>`,
		);

	const sheetPage = (book: Workbook, sheet: Sheet) => {
		const { lastRow, lastCol } = usedBounds(sheet);
		const rows = Math.min(MAX_ROWS, Math.max(lastRow + 12, 30));
		const cols = Math.min(MAX_COLS, Math.max(lastCol + 4, 8));
		const hidden = hiddenRows(book, sheet);
		const cells = cellPayload(book, sheet);
		const headers: Record<string, string> = {};
		for (let c = 0; c < cols; c++) headers[columnLetter(c)] = cells[cellName(c, 1)]?.display ?? "";
		const columnHeads = Array.from({ length: cols }, (_, c) => {
			const letter = columnLetter(c);
			const filtered = letter in sheet.filters;
			return `<div class="ch${filtered ? " filtered" : ""}" role="columnheader" data-col="${letter}">${letter}${filtered ? " ⧩" : ""}<button type="button" class="col-menu" data-col="${letter}" tabindex="-1" aria-haspopup="menu" aria-label="Column ${letter} menu">▾</button></div>`;
		}).join("");
		const gridRows: string[] = [];
		for (let r = 1; r <= rows; r++) {
			let rowCells = "";
			for (let c = 0; c < cols; c++) {
				const name = cellName(c, r);
				const cell = cells[name];
				const classes = ["cell"];
				if (cell?.kind === "num") classes.push("num");
				if (cell?.kind === "err") classes.push("err");
				if (sheet.comments[name]) classes.push("has-comment");
				rowCells += `<div class="${classes.join(" ")}" role="gridcell" aria-colindex="${c + 1}" data-cell="${name}">${escapeHtml(cell?.display ?? "")}</div>`;
			}
			gridRows.push(
				`<div class="grow" role="row" aria-rowindex="${r}" data-row="${r}"${hidden.has(r) ? " hidden" : ""}><div class="rh" role="rowheader">${r}</div>${rowCells}</div>`,
			);
		}
		const filterEntries = Object.entries(sheet.filters);
		const filterSummary = filterEntries
			.map(([letter, shown]) => {
				const header = headers[letter] ? ` (${escapeHtml(headers[letter])})` : "";
				return `column ${letter}${header} shows ${shown.length} value${shown.length === 1 ? "" : "s"}`;
			})
			.join("; ");
		const hiddenCount = `${hidden.size} row${hidden.size === 1 ? "" : "s"} hidden`;
		const banner =
			filterEntries.length === 0
				? ""
				: `<div class="filter-banner" role="status"><span>Filter on: ${filterSummary} · ${hiddenCount}</span><button type="button" class="secondary" id="clear-filters">Clear all filters</button></div>`;
		const tabs = book.sheets
			.map(
				entry =>
					`<a href="${sheetUrl(book, entry)}"${entry === sheet ? ' aria-current="page"' : ""}>${escapeHtml(entry.name)}</a>`,
			)
			.join("");
		const config = { book: book.id, sheet: sheet.name, rows, cols, lastRow, cells, headers, filters: sheet.filters };
		return render(
			`${sheet.name} · ${book.name}`,
			`<div class="toolbar">
<h1>${escapeHtml(book.name)}</h1>
<details class="fn-help"><summary>Functions</summary><div><p>Start a formula with <code>=</code>. Operators: <code>+ - * / ^ &amp;</code> and comparisons. References: <code>B3</code>, <code>$B$3</code>, <code>B2:B9</code>, <code>B:B</code>, another sheet's <code>Data!B3</code>.</p><p>${FUNCTION_NAMES.join(", ")}</p><p>Ctrl+D fills the selection down from its top row; drag the square handle to fill down or right.</p></div></details>
<a class="button secondary" href="/wb/${book.id}/export.csv?sheet=${encodeURIComponent(sheet.name)}" download="${escapeHtml(sheet.name)}.csv">Export CSV</a>
<span id="save-status" role="status">All changes saved</span>
</div>
${banner}
<div class="formula-row"><div id="name-box" aria-label="Selected cell">A1</div><span class="fx">fx</span><input id="formula-input" aria-label="Formula bar" autocomplete="off" spellcheck="false"></div>
<div class="grid-wrap" id="grid-wrap"><div id="grid" role="grid" tabindex="0" aria-label="${escapeHtml(sheet.name)} sheet" aria-rowcount="${rows}" aria-colcount="${cols}">
<div class="grow head" role="row"><div class="corner"></div>${columnHeads}</div>
${gridRows.join("\n")}
<div id="fill-handle" hidden aria-hidden="true"></div>
</div></div>
<nav class="tabs" aria-label="Sheets">${tabs}</nav>
<div id="col-menu" class="popup" role="menu" hidden><div class="menu-title muted" style="padding:4px 12px;font-size:12px"></div><button type="button" role="menuitem" data-action="asc">Sort sheet A → Z (ascending)</button><button type="button" role="menuitem" data-action="desc">Sort sheet Z → A (descending)</button><button type="button" role="menuitem" data-action="filter">Filter by value…</button><button type="button" role="menuitem" data-action="clear">Clear filter</button></div>
<div id="filter-pop" class="popup" hidden></div>
<div id="comment-pop" role="tooltip" hidden></div>
<script type="application/json" id="sheet-data">${JSON.stringify(config).replaceAll("<", "\\u003c")}</script>`,
			SHEET_SCRIPT,
		);
	};

	const fail = (status: number, error: string) => json({ error }, { status });

	const api = (request: SiteRequest, book: Workbook, action: string): SiteResponse => {
		if (action === "comment" && request.method === "GET") {
			const sheet = findSheet(book, request.url.searchParams.get("sheet") ?? "");
			const comment = sheet?.comments[(request.url.searchParams.get("cell") ?? "").toUpperCase()];
			return comment ? json(comment) : fail(404, "that cell has no comment");
		}
		if (request.method !== "POST") return fail(405, "use POST");
		const fields = jsonBody(request);
		if (!isRecord(fields)) return fail(400, "send a JSON object");
		const sheet = findSheet(book, typeof fields.sheet === "string" ? fields.sheet : "");
		if (!sheet) return fail(404, "no such sheet");
		const done = () => {
			changes++;
			return json({ cells: cellPayload(book, sheet) });
		};
		if (action === "cells") {
			const edits: unknown[] = Array.isArray(fields.edits) ? fields.edits : [];
			if (edits.length === 0) return fail(400, "send the edits");
			const parsed: { cell: string; raw: string }[] = [];
			for (const edit of edits) {
				const address = isRecord(edit) && typeof edit.cell === "string" ? parseCellName(edit.cell) : null;
				const raw = isRecord(edit) && typeof edit.raw === "string" ? edit.raw : null;
				if (!address || raw === null) return fail(400, "each edit needs a cell inside the sheet and its text");
				if (raw.length > MAX_INPUT) return fail(400, `a cell holds at most ${MAX_INPUT} characters`);
				parsed.push({ cell: cellName(address.col, address.row), raw });
			}
			for (const edit of parsed) setCell(sheet, edit.cell, edit.raw);
			return done();
		}
		if (action === "fill") {
			const source = typeof fields.source === "string" ? parseRect(fields.source) : null;
			const target = typeof fields.target === "string" ? parseRect(fields.target) : null;
			if (!source || !target) return fail(400, "send the source and target ranges, like B2 and B2:B20");
			const problem = fillRect(sheet, source, target);
			return problem ? fail(400, problem) : done();
		}
		if (action === "sort") {
			const col = typeof fields.col === "string" && /^[A-Z]$/i.test(fields.col) ? columnIndex(fields.col) : -1;
			const direction: SortDirection | null = fields.dir === "asc" ? "asc" : fields.dir === "desc" ? "desc" : null;
			if (col < 0 || !direction) return fail(400, "send a column letter and dir asc or desc");
			sortRows(book, sheet, col, direction);
			return done();
		}
		if (action === "filter") {
			if (fields.col === null) {
				sheet.filters = {};
				return done();
			}
			const col = typeof fields.col === "string" && /^[A-Z]$/i.test(fields.col) ? fields.col.toUpperCase() : null;
			if (!col) return fail(400, "send a column letter, or null to clear every filter");
			if (fields.values === null) {
				const rest = { ...sheet.filters };
				delete rest[col];
				sheet.filters = rest;
				return done();
			}
			const values: unknown[] | null = Array.isArray(fields.values) ? fields.values : null;
			const shown = values?.filter((value): value is string => typeof value === "string");
			if (!values || !shown || shown.length !== values.length) {
				return fail(400, "send the values to show, or null to clear the filter");
			}
			sheet.filters = { ...sheet.filters, [col]: shown };
			return done();
		}
		return fail(404, "no such action");
	};

	const route = (request: SiteRequest): SiteResponse => {
		const { pathname, searchParams } = request.url;
		if (pathname === "/" && request.method === "GET") return home();
		const apiMatch = /^\/api\/wb\/([A-Z0-9]+)\/([a-z]+)$/.exec(pathname);
		if (apiMatch) {
			const book = findWorkbook(world, apiMatch[1] as string);
			return book ? api(request, book, apiMatch[2] as string) : fail(404, "no such workbook");
		}
		const pageMatch = /^\/wb\/([A-Z0-9]+)(\/export\.csv)?$/.exec(pathname);
		if (pageMatch && request.method === "GET") {
			const book = findWorkbook(world, pageMatch[1] as string);
			if (!book) return text("No such workbook", { status: 404 });
			const requested = searchParams.get("sheet");
			const sheet = requested === null ? book.sheets[0] : findSheet(book, requested);
			if (!sheet) return text("No such sheet", { status: 404 });
			if (pageMatch[2]) {
				return text(sheetCsv(book, sheet), {
					headers: {
						"content-type": "text/csv; charset=utf-8",
						"content-disposition": `attachment; filename="${sheet.name.replaceAll(/[^A-Za-z0-9 _-]/g, "")}.csv"`,
					},
				});
			}
			if (requested === null) return redirect(sheetUrl(book, sheet));
			return sheetPage(book, sheet);
		}
		return text("Not found", { status: 404 });
	};

	const site = await hostSite(route);

	return {
		origin: site.origin,
		close: () => site.close(),
		async finish() {
			await site.close();
			return {
				workbooks: world.workbooks.map(book => ({
					id: book.id,
					name: book.name,
					sheets: book.sheets.map(sheet => ({
						name: sheet.name,
						cells: sheet.cells,
						values: sheetValues(book, sheet),
						filters: sheet.filters,
					})),
				})),
				changes,
			};
		},
	};
}
