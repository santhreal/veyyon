/**
 * Gridwork's formula language, shared by the server and the graders: A1 addresses, the parser for
 * what a cell may hold, the evaluator that turns raw inputs into values, and the reference shifting
 * that fill and sort apply to a formula they move.
 *
 * A raw input that starts with `=` is a formula; one that reads as a number (`1,250`, `$4.50`, `-3`)
 * is a number; `TRUE` and `FALSE` are booleans; anything else is text. Formulas support numbers,
 * strings, `+ - * / ^ &`, comparisons, cell references (`B3`, `$B$3`, `Data!B3`, `'Q1 Sales'!B3`),
 * ranges (`B2:D9`, whole columns `B:B`) and the functions in {@link FUNCTION_NAMES}.
 */

/** Columns A to Z and rows 1 to 500: the largest sheet a workbook holds. */
export const MAX_COLS = 26;
export const MAX_ROWS = 500;

export const FUNCTION_NAMES = [
	"SUM",
	"AVERAGE",
	"MIN",
	"MAX",
	"COUNT",
	"COUNTA",
	"PRODUCT",
	"ROUND",
	"ABS",
	"IF",
	"AND",
	"OR",
	"NOT",
	"SUMIF",
	"AVERAGEIF",
	"COUNTIF",
] as const;

export interface CellAddress {
	/** 0 for column A. */
	readonly col: number;
	/** 1 for the first row. */
	readonly row: number;
}

/** A block of cells, corners included, `c1 <= c2` and `r1 <= r2`. */
export interface Rect {
	readonly c1: number;
	readonly r1: number;
	readonly c2: number;
	readonly r2: number;
}

export interface CellError {
	readonly error: string;
}

export type CellValue = number | string | boolean | CellError;
/** A cell's value; null when the cell is empty. */
export type Value = CellValue | null;

export function columnLetter(col: number): string {
	let out = "";
	for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
	return out;
}

export function columnIndex(letters: string): number {
	let n = 0;
	for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

export function cellName(col: number, row: number): string {
	return `${columnLetter(col)}${row}`;
}

/** The address a name like `B7` states, or null when it is not a cell inside the sheet's bounds. */
export function parseCellName(name: string): CellAddress | null {
	const match = /^([A-Za-z]{1,2})(\d{1,4})$/.exec(name.trim());
	if (!match) return null;
	const col = columnIndex(match[1] as string);
	const row = Number(match[2]);
	if (col < 0 || col >= MAX_COLS || row < 1 || row > MAX_ROWS) return null;
	return { col, row };
}

/** `B2:C9`, or one cell `B2` as a one-cell block; the corners may come in either order. */
export function parseRect(text: string): Rect | null {
	const parts = text.split(":");
	if (parts.length > 2) return null;
	const start = parseCellName(parts[0] ?? "");
	const end = parseCellName(parts[1] ?? parts[0] ?? "");
	if (!start || !end) return null;
	return {
		c1: Math.min(start.col, end.col),
		r1: Math.min(start.row, end.row),
		c2: Math.max(start.col, end.col),
		r2: Math.max(start.row, end.row),
	};
}

export function isError(value: unknown): value is CellError {
	return typeof value === "object" && value !== null && "error" in value;
}

function fault(code: string): CellError {
	return { error: code };
}

const NUMBER_INPUT = /^([-+]?)\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)$/;

/** The number a typed input states (`1,250`, `$4.50`, `-3`, `.5`), or null when it states none. */
export function parseNumberInput(text: string): number | null {
	const match = NUMBER_INPUT.exec(text.trim());
	if (!match) return null;
	const value = Number((match[2] as string).replaceAll(",", ""));
	return match[1] === "-" ? -value : value;
}

/** What a raw input that is not a formula holds. */
export function literalValue(raw: string): Value {
	if (raw.trim() === "") return null;
	const number = parseNumberInput(raw);
	if (number !== null) return number;
	const upper = raw.trim().toUpperCase();
	if (upper === "TRUE") return true;
	if (upper === "FALSE") return false;
	return raw;
}

/** Twelve significant digits, so `0.1 + 0.2` shows as `0.3`. */
export function formatNumber(value: number): string {
	if (!Number.isFinite(value)) return "#NUM!";
	const rounded = Number(value.toPrecision(12));
	return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** A value as the grid shows it. */
export function displayValue(value: Value): string {
	if (value === null) return "";
	if (typeof value === "number") return formatNumber(value);
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
	if (typeof value === "string") return value;
	return value.error;
}

/** Round half away from zero to `digits` decimals, as a spreadsheet's ROUND does. */
export function roundTo(value: number, digits: number): number {
	const sign = Math.sign(value);
	const magnitude = Math.abs(value);
	if (digits >= 0) {
		const factor = 10 ** digits;
		// toPrecision drops the binary noise that would turn 8.645 into 8.644999…
		return (sign * Math.round(Number((magnitude * factor).toPrecision(15)))) / factor;
	}
	const factor = 10 ** -digits;
	return sign * Math.round(Number((magnitude / factor).toPrecision(15))) * factor;
}

// ---------------------------------------------------------------------------------------------
// Tokens

class FormulaError extends Error {}

interface RefPart {
	readonly sheet: string | null;
	/** The sheet prefix as written (`Data!`, `'Q1 Sales'!`), kept when the reference is shifted. */
	readonly prefix: string;
	readonly col: number;
	readonly colAbsolute: boolean;
	/** Null for a whole-column reference such as each side of `B:B`. */
	readonly row: number | null;
	readonly rowAbsolute: boolean;
}

interface Span {
	readonly start: number;
	readonly end: number;
}

type Token = Span &
	(
		| { readonly kind: "number"; readonly value: number }
		| { readonly kind: "string"; readonly value: string }
		| { readonly kind: "error"; readonly value: string }
		| { readonly kind: "ref"; readonly ref: RefPart }
		| { readonly kind: "name"; readonly value: string }
		| { readonly kind: "op"; readonly value: string }
	);

function matchRef(source: string, at: number, previous: Token | undefined): { part: RefPart; end: number } | null {
	let cursor = at;
	let sheet: string | null = null;
	let prefix = "";
	const quoted = /^'((?:[^']|'')+)'!/.exec(source.slice(cursor));
	const bare = quoted ? null : /^([A-Za-z_][A-Za-z0-9_.]*)!/.exec(source.slice(cursor));
	const sheetMatch = quoted ?? bare;
	if (sheetMatch) {
		sheet = (sheetMatch[1] as string).replaceAll("''", "'");
		prefix = sheetMatch[0];
		cursor += sheetMatch[0].length;
	} else if (source[cursor] === "'") {
		return null;
	}
	const rest = source.slice(cursor);
	const cell = /^(\$?)([A-Za-z]{1,2})(\$?)(\d+)(?![A-Za-z0-9_(!])/.exec(rest);
	if (cell) {
		return {
			part: {
				sheet,
				prefix,
				col: columnIndex(cell[2] as string),
				colAbsolute: cell[1] === "$",
				row: Number(cell[4]),
				rowAbsolute: cell[3] === "$",
			},
			end: cursor + cell[0].length,
		};
	}
	const column = /^(\$?)([A-Za-z]{1,2})(?![A-Za-z0-9_(!$])/.exec(rest);
	if (column) {
		const next = rest.slice(column[0].length).trimStart();
		const afterColon = previous?.kind === "op" && previous.value === ":";
		if (next.startsWith(":") || afterColon) {
			return {
				part: {
					sheet,
					prefix,
					col: columnIndex(column[2] as string),
					colAbsolute: column[1] === "$",
					row: null,
					rowAbsolute: false,
				},
				end: cursor + column[0].length,
			};
		}
	}
	if (sheet !== null) throw new FormulaError(`${prefix} is not followed by a cell reference`);
	return null;
}

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let at = 0;
	while (at < source.length) {
		const ch = source[at] as string;
		if (/\s/.test(ch)) {
			at++;
			continue;
		}
		const start = at;
		const rest = source.slice(at);
		const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/.exec(rest);
		if (number) {
			at += number[0].length;
			tokens.push({ kind: "number", value: Number(number[0]), start, end: at });
			continue;
		}
		if (ch === '"') {
			let value = "";
			at++;
			for (;;) {
				if (at >= source.length) throw new FormulaError("a string is not closed");
				const c = source[at] as string;
				if (c === '"') {
					if (source[at + 1] === '"') {
						value += '"';
						at += 2;
						continue;
					}
					at++;
					break;
				}
				value += c;
				at++;
			}
			tokens.push({ kind: "string", value, start, end: at });
			continue;
		}
		const error = /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|CIRC!|ERROR!)/i.exec(rest);
		if (error) {
			at += error[0].length;
			tokens.push({ kind: "error", value: error[0].toUpperCase(), start, end: at });
			continue;
		}
		const ref = matchRef(source, at, tokens[tokens.length - 1]);
		if (ref) {
			at = ref.end;
			tokens.push({ kind: "ref", ref: ref.part, start, end: at });
			continue;
		}
		const name = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest);
		if (name) {
			at += name[0].length;
			tokens.push({ kind: "name", value: name[0].toUpperCase(), start, end: at });
			continue;
		}
		const op = /^(?:<=|>=|<>|[-+*/^&=<>:,()])/.exec(rest);
		if (op) {
			at += op[0].length;
			tokens.push({ kind: "op", value: op[0], start, end: at });
			continue;
		}
		throw new FormulaError(`unexpected "${ch}"`);
	}
	return tokens;
}

// ---------------------------------------------------------------------------------------------
// Syntax tree

type Node =
	| { readonly t: "value"; readonly v: CellValue }
	| { readonly t: "ref"; readonly sheet: string | null; readonly col: number; readonly row: number }
	| {
			readonly t: "range";
			readonly sheet: string | null;
			readonly c1: number;
			readonly r1: number;
			readonly c2: number;
			/** Null for whole columns: down to the sheet's last used row. */
			readonly r2: number | null;
	  }
	| { readonly t: "unary"; readonly op: string; readonly x: Node }
	| { readonly t: "binary"; readonly op: string; readonly a: Node; readonly b: Node }
	| { readonly t: "call"; readonly name: string; readonly args: readonly Node[] };

const COMPARISONS: Readonly<Record<string, true>> = {
	"=": true,
	"<>": true,
	"<": true,
	">": true,
	"<=": true,
	">=": true,
};

const BINARY_LEVELS: readonly Readonly<Record<string, true>>[] = [
	COMPARISONS,
	{ "&": true },
	{ "+": true, "-": true },
	{ "*": true, "/": true },
	{ "^": true },
];

class Parser {
	readonly #tokens: readonly Token[];
	#at = 0;

	constructor(tokens: readonly Token[]) {
		this.#tokens = tokens;
	}

	parse(): Node {
		if (this.#tokens.length === 0) throw new FormulaError("the formula is empty");
		const node = this.#level(0);
		if (this.#at < this.#tokens.length) throw new FormulaError("unexpected text after the formula");
		return node;
	}

	#op(): string | null {
		const token = this.#tokens[this.#at];
		return token?.kind === "op" ? token.value : null;
	}

	#expect(op: string): void {
		if (this.#op() !== op) throw new FormulaError(`expected "${op}"`);
		this.#at++;
	}

	/** Binary operators from the loosest level (index 0) to the tightest; below the last come unary signs. */
	#level(index: number): Node {
		const ops = BINARY_LEVELS[index];
		if (!ops) return this.#unary();
		let a = this.#level(index + 1);
		for (;;) {
			const op = this.#op();
			if (op === null || !ops[op]) return a;
			this.#at++;
			a = { t: "binary", op, a, b: this.#level(index + 1) };
		}
	}

	#unary(): Node {
		const op = this.#op();
		if (op === "-" || op === "+") {
			this.#at++;
			return { t: "unary", op, x: this.#unary() };
		}
		return this.#primary();
	}

	#primary(): Node {
		const token = this.#tokens[this.#at];
		if (!token) throw new FormulaError("the formula ends too soon");
		this.#at++;
		switch (token.kind) {
			case "number":
				return { t: "value", v: token.value };
			case "string":
				return { t: "value", v: token.value };
			case "error":
				return { t: "value", v: fault(token.value) };
			case "ref":
				return this.#reference(token.ref);
			case "name":
				if (this.#op() === "(") return this.#call(token.value);
				if (token.value === "TRUE" || token.value === "FALSE") return { t: "value", v: token.value === "TRUE" };
				return { t: "value", v: fault("#NAME?") };
			case "op":
				if (token.value === "(") {
					const inner = this.#level(0);
					this.#expect(")");
					return inner;
				}
				throw new FormulaError(`unexpected "${token.value}"`);
		}
	}

	#reference(first: RefPart): Node {
		if (this.#op() !== ":") {
			if (first.row === null) throw new FormulaError("a column reference needs a range");
			return { t: "ref", sheet: first.sheet, col: first.col, row: first.row };
		}
		this.#at++;
		const token = this.#tokens[this.#at];
		if (token?.kind !== "ref") throw new FormulaError("a range needs a second reference");
		this.#at++;
		const second = token.ref;
		if (first.sheet !== null && second.sheet !== null && first.sheet.toLowerCase() !== second.sheet.toLowerCase()) {
			throw new FormulaError("a range spans two sheets");
		}
		const sheet = first.sheet ?? second.sheet;
		const c1 = Math.min(first.col, second.col);
		const c2 = Math.max(first.col, second.col);
		if (first.row === null && second.row === null) return { t: "range", sheet, c1, r1: 1, c2, r2: null };
		if (first.row === null || second.row === null) throw new FormulaError("a range mixes a column and a cell");
		return { t: "range", sheet, c1, r1: Math.min(first.row, second.row), c2, r2: Math.max(first.row, second.row) };
	}

	#call(name: string): Node {
		this.#expect("(");
		const args: Node[] = [];
		if (this.#op() === ")") {
			this.#at++;
			return { t: "call", name, args };
		}
		for (;;) {
			args.push(this.#level(0));
			const op = this.#op();
			this.#at++;
			if (op === ")") return { t: "call", name, args };
			if (op !== ",") throw new FormulaError(`expected "," or ")" in ${name}`);
		}
	}
}

function parseFormula(source: string): Node {
	return new Parser(tokenize(source)).parse();
}

// ---------------------------------------------------------------------------------------------
// References, for graders that ask what a formula reads

export interface FormulaReference {
	/** As written; null when the reference names no sheet and so reads the formula's own sheet. */
	readonly sheet: string | null;
	readonly c1: number;
	readonly r1: number;
	readonly c2: number;
	/** Null for whole columns. */
	readonly r2: number | null;
}

/** Every cell and range a formula reads; empty for a raw input that is not a formula or does not parse. */
export function formulaReferences(raw: string): FormulaReference[] {
	if (!raw.startsWith("=")) return [];
	let root: Node;
	try {
		root = parseFormula(raw.slice(1));
	} catch {
		return [];
	}
	const out: FormulaReference[] = [];
	const walk = (node: Node): void => {
		switch (node.t) {
			case "ref":
				out.push({ sheet: node.sheet, c1: node.col, r1: node.row, c2: node.col, r2: node.row });
				return;
			case "range":
				out.push({ sheet: node.sheet, c1: node.c1, r1: node.r1, c2: node.c2, r2: node.r2 });
				return;
			case "unary":
				walk(node.x);
				return;
			case "binary":
				walk(node.a);
				walk(node.b);
				return;
			case "call":
				for (const arg of node.args) walk(arg);
				return;
			case "value":
				return;
		}
	};
	walk(root);
	return out;
}

// ---------------------------------------------------------------------------------------------
// Shifting, for fill and sort

function shiftRef(ref: RefPart, dCol: number, dRow: number): string {
	const col = ref.colAbsolute ? ref.col : ref.col + dCol;
	const row = ref.row === null || ref.rowAbsolute ? ref.row : ref.row + dRow;
	if (col < 0 || col >= MAX_COLS || (row !== null && (row < 1 || row > MAX_ROWS))) return "#REF!";
	const rowText = row === null ? "" : `${ref.rowAbsolute ? "$" : ""}${row}`;
	return `${ref.prefix}${ref.colAbsolute ? "$" : ""}${columnLetter(col)}${rowText}`;
}

/**
 * `raw` as it reads once copied `dCol` columns and `dRow` rows away: each relative reference moves by
 * that offset, each `$`-anchored part stays. A raw input that is not a formula is returned unchanged.
 */
export function shiftFormula(raw: string, dCol: number, dRow: number): string {
	if (!raw.startsWith("=") || (dCol === 0 && dRow === 0)) return raw;
	const source = raw.slice(1);
	let tokens: Token[];
	try {
		tokens = tokenize(source);
	} catch {
		return raw;
	}
	let out = "=";
	let last = 0;
	for (const token of tokens) {
		if (token.kind !== "ref") continue;
		out += source.slice(last, token.start) + shiftRef(token.ref, dCol, dRow);
		last = token.end;
	}
	return out + source.slice(last);
}

// ---------------------------------------------------------------------------------------------
// Evaluation

export interface SheetCells {
	readonly name: string;
	readonly cells: Readonly<Record<string, string>>;
}

interface RangeValue {
	readonly grid: readonly (readonly Value[])[];
}

type Result = Value | RangeValue;

function isRange(result: Result): result is RangeValue {
	return typeof result === "object" && result !== null && "grid" in result;
}

function toNumber(value: Value): number | CellError {
	if (value === null) return 0;
	if (typeof value === "number") return value;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "string") {
		if (value.trim() === "") return 0;
		return parseNumberInput(value) ?? fault("#VALUE!");
	}
	return value;
}

function toBoolean(value: Value): boolean | CellError {
	if (value === null) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") {
		const upper = value.trim().toUpperCase();
		if (upper === "TRUE") return true;
		if (upper === "FALSE") return false;
		return fault("#VALUE!");
	}
	return value;
}

function typeRank(value: number | string | boolean): number {
	return typeof value === "number" ? 0 : typeof value === "string" ? 1 : 2;
}

/** Numbers sort before text, text before booleans; text compares without case. */
export function compareValues(a: number | string | boolean | null, b: number | string | boolean | null): number {
	const blankFor = (other: number | string | boolean | null) =>
		typeof other === "string" ? "" : typeof other === "boolean" ? false : 0;
	const x = a ?? blankFor(b);
	const y = b ?? blankFor(x);
	const rx = typeRank(x);
	const ry = typeRank(y);
	if (rx !== ry) return rx - ry;
	if (typeof x === "string" && typeof y === "string") {
		const p = x.toLowerCase();
		const q = y.toLowerCase();
		return p < q ? -1 : p > q ? 1 : 0;
	}
	const p = Number(x);
	const q = Number(y);
	return p < q ? -1 : p > q ? 1 : 0;
}

function compareOp(op: string, order: number): boolean {
	switch (op) {
		case "=":
			return order === 0;
		case "<>":
			return order !== 0;
		case "<":
			return order < 0;
		case ">":
			return order > 0;
		case "<=":
			return order <= 0;
		default:
			return order >= 0;
	}
}

function numericOf(value: Value): number | null {
	if (typeof value === "number") return value;
	if (typeof value === "string") return parseNumberInput(value);
	return null;
}

/** The test a SUMIF, AVERAGEIF or COUNTIF criterion (`"North"`, `">100"`, `5`, `"<>"`) applies to each cell. */
function criterionTest(criterion: number | string | boolean | null): (value: Value) => boolean {
	if (typeof criterion === "number") return value => numericOf(value) === criterion;
	if (typeof criterion === "boolean") return value => value === criterion;
	const match = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(criterion ?? "") as RegExpExecArray;
	const op = match[1] ?? "=";
	const operand = match[2] as string;
	const number = parseNumberInput(operand);
	if (number !== null) {
		return value => {
			const n = numericOf(value);
			if (n === null) return op === "<>";
			return compareOp(op, n - number);
		};
	}
	const blank = (value: Value) => value === null || value === "";
	if (operand === "") return value => (op === "<>" ? !blank(value) : op === "=" ? blank(value) : false);
	const matchesPattern = wildcardTest(operand);
	return value => {
		if (op === "=" || op === "<>") {
			const matches = typeof value === "string" && matchesPattern(value);
			return op === "=" ? matches : !matches;
		}
		if (typeof value !== "string") return false;
		return compareOp(op, compareValues(value, operand));
	};
}

/**
 * The test of whether a text matches a criterion's pattern, `*` standing for any run of characters
 * and `?` for one, ignoring case. The pattern splits at its stars: the text starts with the first
 * part, ends with the last, and holds the parts between in order, each placed at its leftmost fit.
 * A leftmost placement never loses a match, so no placement is retried: the work is at most the
 * text's length times the pattern's, however many stars the pattern holds.
 */
function wildcardTest(pattern: string): (text: string) => boolean {
	const parts = pattern.toLowerCase().split("*");
	const head = parts[0] as string;
	const tail = parts.length > 1 ? (parts[parts.length - 1] as string) : "";
	const middle = parts.slice(1, -1);
	const fits = (text: string, at: number, part: string): boolean => {
		for (let k = 0; k < part.length; k++) {
			if (part[k] !== "?" && part[k] !== text[at + k]) return false;
		}
		return true;
	};
	return value => {
		const text = value.toLowerCase();
		if (parts.length === 1) return text.length === head.length && fits(text, 0, head);
		const end = text.length - tail.length;
		if (end < head.length || !fits(text, 0, head) || !fits(text, end, tail)) return false;
		let at = head.length;
		for (const part of middle) {
			let start = at;
			while (start + part.length <= end && !fits(text, start, part)) start++;
			if (start + part.length > end) return false;
			at = start + part.length;
		}
		return true;
	};
}

interface Area {
	readonly sheet: SheetCells;
	readonly rect: Rect;
}

/**
 * How deep one evaluation nests, counting every operator, call and reference it passes through. A
 * longer chain of references evaluates to `#ERROR!` instead of exhausting the stack; a formula
 * filled down every row of a sheet nests well inside it.
 */
const MAX_DEPTH = 2000;

/**
 * Evaluates the cells of one workbook. Values are computed on demand and remembered, so build a new
 * evaluator after the workbook changes.
 */
export class Evaluator {
	readonly #sheets = new Map<string, SheetCells>();
	readonly #values = new Map<string, Value>();
	readonly #pending = new Set<string>();
	readonly #lastRows = new Map<string, number>();
	#depth = 0;

	constructor(sheets: readonly SheetCells[]) {
		for (const sheet of sheets) this.#sheets.set(sheet.name.toLowerCase(), sheet);
	}

	/** The value of one cell; `#REF!` when the sheet does not exist. */
	value(sheetName: string, cell: string): Value {
		const sheet = this.#sheets.get(sheetName.toLowerCase());
		return sheet ? this.#cell(sheet, cell) : fault("#REF!");
	}

	#cell(sheet: SheetCells, cell: string): Value {
		const key = `${sheet.name.toLowerCase()}!${cell}`;
		const known = this.#values.get(key);
		if (known !== undefined) return known;
		if (this.#pending.has(key)) return fault("#CIRC!");
		const raw = sheet.cells[cell];
		if (raw === undefined) return null;
		this.#pending.add(key);
		let value: Value;
		try {
			value = raw.startsWith("=") ? this.#formula(sheet, raw.slice(1)) : literalValue(raw);
		} finally {
			this.#pending.delete(key);
		}
		this.#values.set(key, value);
		return value;
	}

	#formula(sheet: SheetCells, source: string): Value {
		let root: Node;
		try {
			root = parseFormula(source);
		} catch {
			return fault("#ERROR!");
		}
		return this.#scalar(root, sheet) ?? 0;
	}

	#lastRow(sheet: SheetCells): number {
		const key = sheet.name.toLowerCase();
		const known = this.#lastRows.get(key);
		if (known !== undefined) return known;
		let last = 0;
		for (const name of Object.keys(sheet.cells)) last = Math.max(last, parseCellName(name)?.row ?? 0);
		this.#lastRows.set(key, last);
		return last;
	}

	#sheetFor(name: string | null, current: SheetCells): SheetCells | null {
		return name === null ? current : (this.#sheets.get(name.toLowerCase()) ?? null);
	}

	#area(node: Node, current: SheetCells): Area | CellError {
		if (node.t !== "ref" && node.t !== "range") return fault("#VALUE!");
		const sheet = this.#sheetFor(node.sheet, current);
		if (!sheet) return fault("#REF!");
		if (node.t === "ref") return { sheet, rect: { c1: node.col, r1: node.row, c2: node.col, r2: node.row } };
		const r2 = node.r2 ?? Math.max(node.r1, this.#lastRow(sheet));
		return { sheet, rect: { c1: node.c1, r1: node.r1, c2: node.c2, r2 } };
	}

	#read(area: Area): Value[][] {
		const rows: Value[][] = [];
		const { rect } = area;
		for (let r = rect.r1; r <= Math.min(rect.r2, MAX_ROWS); r++) {
			const row: Value[] = [];
			for (let c = rect.c1; c <= Math.min(rect.c2, MAX_COLS - 1); c++) {
				row.push(this.#cell(area.sheet, cellName(c, r)));
			}
			rows.push(row);
		}
		return rows;
	}

	#eval(node: Node, sheet: SheetCells): Result {
		if (this.#depth >= MAX_DEPTH) return fault("#ERROR!");
		this.#depth++;
		try {
			switch (node.t) {
				case "value":
					return node.v;
				case "ref": {
					const target = this.#sheetFor(node.sheet, sheet);
					if (!target || node.col >= MAX_COLS || node.row > MAX_ROWS) return fault("#REF!");
					return this.#cell(target, cellName(node.col, node.row));
				}
				case "range": {
					const area = this.#area(node, sheet);
					return isError(area) ? area : { grid: this.#read(area) };
				}
				case "unary": {
					const value = this.#scalar(node.x, sheet);
					if (node.op === "+") return value;
					const n = toNumber(value);
					return isError(n) ? n : -n;
				}
				case "binary":
					return this.#binary(node.op, this.#scalar(node.a, sheet), this.#scalar(node.b, sheet));
				case "call":
					return this.#call(node.name, node.args, sheet);
			}
		} finally {
			this.#depth--;
		}
	}

	#scalar(node: Node, sheet: SheetCells): Value {
		const result = this.#eval(node, sheet);
		if (!isRange(result)) return result;
		const only = result.grid.length === 1 && result.grid[0]?.length === 1 ? result.grid[0][0] : undefined;
		return only === undefined ? fault("#VALUE!") : only;
	}

	#binary(op: string, a: Value, b: Value): Value {
		if (isError(a)) return a;
		if (isError(b)) return b;
		if (op === "&") return displayValue(a) + displayValue(b);
		if (COMPARISONS[op]) return compareOp(op, compareValues(a, b));
		const x = toNumber(a);
		if (isError(x)) return x;
		const y = toNumber(b);
		if (isError(y)) return y;
		let out: number;
		switch (op) {
			case "+":
				out = x + y;
				break;
			case "-":
				out = x - y;
				break;
			case "*":
				out = x * y;
				break;
			case "/":
				if (y === 0) return fault("#DIV/0!");
				out = x / y;
				break;
			default:
				out = x ** y;
		}
		return Number.isFinite(out) ? out : fault("#NUM!");
	}

	/** The numbers an aggregate reads: numbers only from references, every argument coerced otherwise. */
	#numbers(args: readonly Node[], sheet: SheetCells): number[] | CellError {
		const out: number[] = [];
		for (const arg of args) {
			if (arg.t === "ref" || arg.t === "range") {
				const area = this.#area(arg, sheet);
				if (isError(area)) return area;
				for (const row of this.#read(area)) {
					for (const value of row) {
						if (isError(value)) return value;
						if (typeof value === "number") out.push(value);
					}
				}
				continue;
			}
			const value = this.#scalar(arg, sheet);
			if (value === null) continue;
			const n = toNumber(value);
			if (isError(n)) return n;
			out.push(n);
		}
		return out;
	}

	#flatValues(args: readonly Node[], sheet: SheetCells): Value[] | CellError {
		const out: Value[] = [];
		for (const arg of args) {
			if (arg.t === "ref" || arg.t === "range") {
				const area = this.#area(arg, sheet);
				if (isError(area)) return area;
				for (const row of this.#read(area)) out.push(...row);
			} else {
				out.push(this.#scalar(arg, sheet));
			}
		}
		return out;
	}

	#call(name: string, args: readonly Node[], sheet: SheetCells): Value {
		const arity = (min: number, max: number) => args.length >= min && args.length <= max;
		switch (name) {
			case "SUM":
			case "AVERAGE":
			case "MIN":
			case "MAX":
			case "PRODUCT": {
				if (args.length === 0) return fault("#N/A");
				const numbers = this.#numbers(args, sheet);
				if (isError(numbers)) return numbers;
				if (name === "SUM") return numbers.reduce((sum, n) => sum + n, 0);
				if (name === "AVERAGE") {
					return numbers.length === 0 ? fault("#DIV/0!") : numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
				}
				if (numbers.length === 0) return 0;
				if (name === "MIN") return Math.min(...numbers);
				if (name === "MAX") return Math.max(...numbers);
				return numbers.reduce((product, n) => product * n, 1);
			}
			case "COUNT":
			case "COUNTA": {
				const values = this.#flatValues(args, sheet);
				if (isError(values)) return values;
				return values.filter(value => (name === "COUNT" ? typeof value === "number" : value !== null)).length;
			}
			case "ROUND": {
				if (!arity(1, 2)) return fault("#N/A");
				const x = toNumber(this.#scalar(args[0] as Node, sheet));
				if (isError(x)) return x;
				const digits = args[1] ? toNumber(this.#scalar(args[1], sheet)) : 0;
				if (isError(digits)) return digits;
				return roundTo(x, Math.trunc(digits));
			}
			case "ABS": {
				if (!arity(1, 1)) return fault("#N/A");
				const x = toNumber(this.#scalar(args[0] as Node, sheet));
				return isError(x) ? x : Math.abs(x);
			}
			case "IF": {
				if (!arity(2, 3)) return fault("#N/A");
				const condition = toBoolean(this.#scalar(args[0] as Node, sheet));
				if (isError(condition)) return condition;
				const branch = condition ? args[1] : args[2];
				if (!branch) return false;
				return this.#scalar(branch, sheet) ?? 0;
			}
			case "AND":
			case "OR": {
				if (args.length === 0) return fault("#N/A");
				const values = this.#flatValues(args, sheet);
				if (isError(values)) return values;
				const flags: boolean[] = [];
				for (const value of values) {
					if (isError(value)) return value;
					if (typeof value === "boolean" || typeof value === "number") flags.push(Boolean(value));
				}
				if (flags.length === 0) return fault("#VALUE!");
				return name === "AND" ? flags.every(Boolean) : flags.some(Boolean);
			}
			case "NOT": {
				if (!arity(1, 1)) return fault("#N/A");
				const flag = toBoolean(this.#scalar(args[0] as Node, sheet));
				return isError(flag) ? flag : !flag;
			}
			case "SUMIF":
			case "AVERAGEIF":
			case "COUNTIF":
				return this.#conditional(name, args, sheet);
			default:
				return fault("#NAME?");
		}
	}

	#conditional(name: string, args: readonly Node[], sheet: SheetCells): Value {
		if (args.length < 2 || args.length > (name === "COUNTIF" ? 2 : 3)) return fault("#N/A");
		const tested = this.#area(args[0] as Node, sheet);
		if (isError(tested)) return tested;
		const criterion = this.#scalar(args[1] as Node, sheet);
		if (isError(criterion)) return criterion;
		const test = criterionTest(criterion);
		let summed = tested;
		if (args[2]) {
			const area = this.#area(args[2], sheet);
			if (isError(area)) return area;
			// The summed cells take the tested range's shape from the summed range's top-left cell.
			summed = {
				sheet: area.sheet,
				rect: {
					c1: area.rect.c1,
					r1: area.rect.r1,
					c2: area.rect.c1 + (tested.rect.c2 - tested.rect.c1),
					r2: area.rect.r1 + (tested.rect.r2 - tested.rect.r1),
				},
			};
		}
		const testedGrid = this.#read(tested);
		const summedGrid = this.#read(summed);
		let count = 0;
		let total = 0;
		for (let r = 0; r < testedGrid.length; r++) {
			const row = testedGrid[r] as Value[];
			for (let c = 0; c < row.length; c++) {
				const value = row[c] as Value;
				if (isError(value) || !test(value)) continue;
				if (name === "COUNTIF") {
					count++;
					continue;
				}
				const addend = summedGrid[r]?.[c] ?? null;
				if (isError(addend)) return addend;
				if (typeof addend !== "number") continue;
				total += addend;
				count++;
			}
		}
		if (name === "COUNTIF") return count;
		if (name === "SUMIF") return total;
		return count === 0 ? fault("#DIV/0!") : total / count;
	}
}
