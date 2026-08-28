import type { CellAlign, Ctx, Span } from "./latex-block";
import {
	BINOM_COMMANDS,
	DISPLAY_ROW_ENVIRONMENTS,
	FRAC_COMMANDS,
	GRID_ENVIRONMENTS,
	INTEGRAL_OPERATORS,
	LIMIT_OPERATORS,
	ROOT_CTX,
	attachScripts,
	binomBox,
	delimBox,
	delimColumn,
	delimKey,
	fracBox,
	gridBox,
	hconcat,
	limitsBox,
	matchDelim,
	radicalBox,
	readArg,
	readBraceGroup,
	readEnvironment,
	readLeftRight,
	splitRows,
	textBox,
	vconcat,
} from "./latex-block";
import { latexColorScope, latexToUnicode, MATH_FONT_COMMANDS } from "./latex-to-unicode";
interface Box {
	lines: string[];
	baseline: number;
	width: number;
}

function splitCells(row: string): string[] {
	const cells: string[] = [];
	let braceDepth = 0;
	let envDepth = 0;
	let last = 0;
	let i = 0;
	while (i < row.length) {
		if (row.startsWith("\\begin", i)) {
			envDepth++;
			i += 6;
			continue;
		}
		if (row.startsWith("\\end", i)) {
			envDepth--;
			i += 4;
			continue;
		}
		const c = row[i];
		if (c === "\\") {
			i += 2; // `\&` and command heads never split
			continue;
		}
		if (c === "{") braceDepth++;
		else if (c === "}") braceDepth--;
		else if (c === "&" && braceDepth === 0 && envDepth === 0) {
			cells.push(row.slice(last, i));
			last = i + 1;
		}
		i++;
	}
	cells.push(row.slice(last));
	for (let ci = 0; ci < cells.length; ci++) cells[ci] = cells[ci]!.trim();
	return cells;
}

function readScript(src: string, i: number): Span {
	let out = src[i];
	i++;
	while (src[i] === " ") {
		out += src[i];
		i++;
	}
	if (src[i] === "{") {
		const group = readBraceGroup(src, i);
		return { text: `${out}{${group.text}}`, end: group.end };
	}
	if (src[i] === "\\") {
		let j = i + 1;
		if (/[A-Za-z]/.test(src[j] ?? "")) while (/[A-Za-z]/.test(src[j] ?? "")) j++;
		else j++;
		return { text: out + src.slice(i, j), end: j };
	}
	if (i < src.length) return { text: out + src[i], end: i + 1 };
	return { text: out, end: i };
}

function scriptArgOf(text: string): string {
	let arg = text.slice(1).trimStart();
	if (arg.startsWith("{") && arg.endsWith("}")) arg = arg.slice(1, -1);
	return arg;
}

function parseEnvironment(src: string, start: number, ctx: Ctx): { box: Box; end: number } | null {
	const env = readEnvironment(src, start);
	if (env === null) return null;
	const starred = env.env.endsWith("*");
	const base = starred ? env.env.slice(0, -1) : env.env;
	const gridDelims = GRID_ENVIRONMENTS[base];
	if (gridDelims) {
		let p = env.bodyStart;
		while (src[p] === " " || src[p] === "\n" || src[p] === "\t") p++;
		if (starred && src[p] === "[") {
			const close = src.indexOf("]", p);
			if (close !== -1 && close < env.bodyEnd) {
				p = close + 1;
				while (src[p] === " " || src[p] === "\n" || src[p] === "\t") p++;
			}
		}
		let colSpec: CellAlign[] | null = null;
		if (base === "array" && src[p] === "{") {
			const spec = readBraceGroup(src, p);
			colSpec = [];
			for (let si = 0; si < spec.text.length; si++) {
				const ch = spec.text.charCodeAt(si);
				if (ch === 0x6c || ch === 0x63 || ch === 0x72) colSpec.push(String.fromCharCode(ch) as CellAlign);
			}
			p = spec.end;
		}
		const rawRows = splitRows(src.slice(p, env.bodyEnd));
		const cells: Box[][] = [];
		for (let ri = 0; ri < rawRows.length; ri++) {
			const trimmed = rawRows[ri]!.trim();
			if (trimmed === "") continue;
			const rowCells = splitCells(trimmed);
			const parsed: Box[] = new Array(rowCells.length);
			for (let ci = 0; ci < rowCells.length; ci++) parsed[ci] = parseExpr(rowCells[ci]!, ctx);
			cells.push(parsed);
		}
		const isCases = base === "cases" || base === "dcases" || base === "rcases" || base === "drcases";
		const align: (col: number) => CellAlign = colSpec ? col => colSpec[col] ?? "c" : isCases ? () => "l" : () => "c";
		const grid = gridBox(cells, align, () => 2, 1);
		return { box: delimBox(grid, gridDelims[0], gridDelims[1]), end: env.end };
	}
	if (!DISPLAY_ROW_ENVIRONMENTS[base]) {
		return { box: textBox(latexToUnicode(ctx.wrap(src.slice(start, env.end)))), end: env.end };
	}
	let bodyStart = env.bodyStart;
	if (base === "alignat" || base === "alignedat" || base === "gatheredat") {
		let p = bodyStart;
		while (src[p] === " " || src[p] === "\n") p++;
		if (src[p] === "{") bodyStart = readBraceGroup(src, p).end;
	}
	const rawBodyRows = splitRows(src.slice(bodyStart, env.bodyEnd));
	const rows: string[] = [];
	for (let ri = 0; ri < rawBodyRows.length; ri++) {
		const trimmed = rawBodyRows[ri]!.trim();
		if (trimmed !== "") rows.push(trimmed);
	}
	if (rows.length === 0) return { box: textBox(""), end: env.end };
	const cellRows: string[][] = new Array(rows.length);
	for (let ri = 0; ri < rows.length; ri++) cellRows[ri] = splitCells(rows[ri]!);
	let ncols = 0;
	for (let ri = 0; ri < cellRows.length; ri++) ncols = Math.max(ncols, cellRows[ri]!.length);
	if (ncols <= 1) {
		const centered = base === "gather" || base === "gathered" || base === "multline";
		const parsedRows: Box[] = new Array(rows.length);
		for (let ri = 0; ri < rows.length; ri++) parsedRows[ri] = parseExpr(rows[ri]!, ctx);
		return {
			box: vconcat(parsedRows, centered ? "c" : "l"),
			end: env.end,
		};
	}
	const parsedGrid: Box[][] = new Array(cellRows.length);
	for (let ri = 0; ri < cellRows.length; ri++) {
		const row = cellRows[ri]!;
		const parsedRow: Box[] = new Array(row.length);
		for (let ci = 0; ci < row.length; ci++) parsedRow[ci] = parseExpr(row[ci]!, ctx);
		parsedGrid[ri] = parsedRow;
	}
	const grid = gridBox(
		parsedGrid,
		col => (col % 2 === 0 ? "r" : "l"),
		col => (col % 2 === 1 ? 1 : 3),
	);
	return { box: grid, end: env.end };
}

function colorizeBox(box: Box, scope: (text: string) => string): Box {
	const lines = new Array<string>(box.lines.length);
	for (let li = 0; li < box.lines.length; li++) lines[li] = scope(box.lines[li]!);
	return { lines, baseline: box.baseline, width: box.width };
}

const MAX_BLOCK_DEPTH = 64;
const MAX_BLOCK_DEGRADE_TAIL = 2048;
let blockDepth = 0;

function parseExpr(src: string, ctx: Ctx = ROOT_CTX): Box {
	if (blockDepth >= MAX_BLOCK_DEPTH) {
		return textBox(
			latexToUnicode(src.length > MAX_BLOCK_DEGRADE_TAIL ? `${src.slice(0, MAX_BLOCK_DEGRADE_TAIL)}…` : src),
		);
	}
	blockDepth++;
	try {
		return parseExprInner(src, ctx);
	} finally {
		blockDepth--;
	}
}

function parseExprInner(src: string, ctx: Ctx = ROOT_CTX): Box {
	const boxes: Box[] = [];
	let inline = "";
	let color = "";
	let colorScope: ((text: string) => string) | null = null;
	const flush = (): void => {
		if (!inline) return;
		boxes.push(textBox(latexToUnicode(ctx.wrap(color + inline))));
		inline = "";
	};
	const inner = (): Ctx => {
		if (!color) return ctx;
		const pre = color;
		return { wrap: run => ctx.wrap(pre + run) };
	};
	const paint = (box: Box): Box => (colorScope === null ? box : colorizeBox(box, colorScope));
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") {
			let j = i + 1;
			let name = "";
			while (j < src.length && /[A-Za-z]/.test(src[j])) {
				name += src[j];
				j++;
			}
			if (name && FRAC_COMMANDS[name]) {
				flush();
				const num = readArg(src, j);
				const den = readArg(src, num.end);
				boxes.push(paint(fracBox(parseExpr(num.text, inner()), parseExpr(den.text, inner()))));
				i = den.end;
				continue;
			}
			if (name && BINOM_COMMANDS[name]) {
				flush();
				const top = readArg(src, j);
				const bottom = readArg(src, top.end);
				boxes.push(paint(binomBox(parseExpr(top.text, inner()), parseExpr(bottom.text, inner()))));
				i = bottom.end;
				continue;
			}
			if (name === "sqrt") {
				let k = j;
				while (src[k] === " ") k++;
				let degree: string | null = null;
				if (src[k] === "[") {
					const close = src.indexOf("]", k);
					degree = src.slice(k + 1, close === -1 ? src.length : close);
					k = close === -1 ? src.length : close + 1;
				}
				const arg = readArg(src, k);
				flush();
				boxes.push(paint(radicalBox(parseExpr(arg.text, inner()), degree)));
				i = arg.end;
				continue;
			}
			if (name === "left") {
				const lr = readLeftRight(src, i);
				if (lr) {
					const segBoxes: Box[] = new Array(lr.segments.length);
					for (let si = 0; si < lr.segments.length; si++) segBoxes[si] = parseExpr(lr.segments[si]!, inner());
					let above = 0;
					let below = 0;
					for (let bi = 0; bi < segBoxes.length; bi++) {
						const b = segBoxes[bi]!;
						above = Math.max(above, b.baseline);
						below = Math.max(below, b.lines.length - 1 - b.baseline);
					}
					const height = above + below + 1;
					if (height === 1) {
						inline += src.slice(i, lr.end);
						i = lr.end;
						continue;
					}
					flush();
					const parts: Box[] = [];
					const push = (col: Box | null): void => {
						if (col) parts.push(col);
					};
					push(delimColumn(delimKey(lr.left), height, above));
					for (let s = 0; s < segBoxes.length; s++) {
						parts.push(segBoxes[s]!);
						if (s < lr.middles.length) push(delimColumn(delimKey(lr.middles[s]), height, above));
					}
					push(delimColumn(delimKey(lr.right), height, above));
					boxes.push(paint(hconcat(parts)));
					i = lr.end;
					continue;
				}
			}
			if (name && (LIMIT_OPERATORS[name] || INTEGRAL_OPERATORS[name])) {
				let k = j;
				while (src[k] === " ") k++;
				let stack = LIMIT_OPERATORS[name] === true;
				let resume = j; // resume point when the operator stays inline
				if (src.startsWith("\\limits", k) && !/[A-Za-z]/.test(src[k + 7] ?? "")) {
					stack = true;
					resume = k = k + 7;
				} else if (src.startsWith("\\nolimits", k) && !/[A-Za-z]/.test(src[k + 9] ?? "")) {
					stack = false;
					resume = k + 9;
				}
				if (stack) {
					let subText: string | null = null;
					let supText: string | null = null;
					let m = k;
					for (;;) {
						let n = m;
						while (src[n] === " ") n++;
						if (src[n] === "_" && subText === null) {
							const arg = readArg(src, n + 1);
							subText = arg.text;
							m = arg.end;
							continue;
						}
						if (src[n] === "^" && supText === null) {
							const arg = readArg(src, n + 1);
							supText = arg.text;
							m = arg.end;
							continue;
						}
						break;
					}
					if (subText !== null || supText !== null) {
						flush();
						const glyph = textBox(latexToUnicode(ctx.wrap(`${color}\\${name}`)));
						boxes.push(
							paint(
								limitsBox(
									glyph,
									subText === null ? null : parseExpr(subText, inner()),
									supText === null ? null : parseExpr(supText, inner()),
								),
							),
						);
						i = m;
						continue;
					}
				}
				inline += `\\${name}`;
				i = resume;
				continue;
			}
			if (name === "color" || name === "normalcolor") {
				flush(); // preceding run keeps the previous color
				if (name === "normalcolor") {
					color = "";
					colorScope = null;
					i = j;
					continue;
				}
				let k = j;
				while (src[k] === " ") k++;
				let opt = "";
				if (src[k] === "[") {
					const close = src.indexOf("]", k);
					if (close !== -1) {
						opt = src.slice(k, close + 1);
						k = close + 1;
						while (src[k] === " ") k++;
					}
				}
				if (src[k] === "{") {
					const spec = readBraceGroup(src, k);
					color = `\\color${opt}{${spec.text}}`;
					colorScope = latexColorScope(opt ? opt.slice(1, -1).trim() : null, spec.text);
					i = spec.end;
				} else {
					color = "";
					colorScope = null;
					i = k;
				}
				continue;
			}
			if (name === "begin") {
				const env = parseEnvironment(src, i, inner());
				if (env) {
					flush();
					boxes.push(paint(env.box));
					i = env.end;
					continue;
				}
			}
			if (name && (MATH_FONT_COMMANDS.has(name) || name === "textcolor")) {
				let k = j;
				while (src[k] === " ") k++;
				let prefix = `\\${name}`;
				let scope: ((text: string) => string) | null = null;
				if (name === "textcolor") {
					let model: string | null = null;
					if (src[k] === "[") {
						const close = src.indexOf("]", k);
						if (close !== -1) {
							model = src.slice(k + 1, close).trim();
							prefix += src.slice(k, close + 1);
							k = close + 1;
							while (src[k] === " ") k++;
						}
					}
					if (src[k] !== "{") {
						inline += `\\${name}`;
						i = j;
						continue;
					}
					const spec = readBraceGroup(src, k);
					prefix += `{${spec.text}}`;
					scope = latexColorScope(model, spec.text);
					k = spec.end;
					while (src[k] === " ") k++;
				}
				if (src[k] === "{") {
					const content = readBraceGroup(src, k);
					flush();
					const pre = color;
					let box = parseExpr(content.text, { wrap: run => ctx.wrap(`${pre}${prefix}{${run}}`) });
					if (scope !== null) box = colorizeBox(box, scope);
					boxes.push(paint(box));
					i = content.end;
					continue;
				}
			}
			if (!name) {
				inline += `\\${src[j] ?? ""}`;
				i = j + 1;
				continue;
			}
			inline += `\\${name}`;
			i = j;
			while (src[i] === "[" || src[i] === "{") {
				if (src[i] === "{") {
					const group = readBraceGroup(src, i);
					inline += `{${group.text}}`;
					i = group.end;
				} else {
					const close = src.indexOf("]", i);
					const end = close === -1 ? src.length : close + 1;
					inline += src.slice(i, end);
					i = end;
				}
			}
			continue;
		}
		if (c === "^" || c === "_") {
			const first = readScript(src, i);
			let second: Span | null = null;
			let n = first.end;
			while (src[n] === " ") n++;
			if (src[n] === (c === "^" ? "_" : "^")) second = readScript(src, n);
			const end = second === null ? first.end : second.end;
			const supText = c === "^" ? first.text : second?.text;
			const subText = c === "_" ? first.text : second?.text;
			const supBox = supText === undefined ? null : parseExpr(scriptArgOf(supText), inner());
			const subBox = subText === undefined ? null : parseExpr(scriptArgOf(subText), inner());
			const unconvertible = (raw: string | undefined): boolean => {
				if (raw === undefined) return false;
				const flat = latexToUnicode(raw);
				return flat.startsWith("^") || flat.startsWith("_");
			};
			const tall = (supBox !== null && supBox.lines.length > 1) || (subBox !== null && subBox.lines.length > 1);
			if (tall || unconvertible(supText) || unconvertible(subText)) {
				flush();
				const base = boxes.pop() ?? textBox("");
				boxes.push(paint(attachScripts(base, subBox, supBox)));
				i = end;
				continue;
			}
			const last = boxes[boxes.length - 1];
			if (inline === "" && last !== undefined && last.lines.length > 1) {
				const corner = (raw: string | undefined): Box | null =>
					raw === undefined ? null : textBox(latexToUnicode(ctx.wrap(color + raw)));
				boxes[boxes.length - 1] = paint(attachScripts(last, corner(subText), corner(supText)));
				i = end;
				continue;
			}
			inline += src.slice(i, end);
			i = end;
			continue;
		}
		if (c === "{") {
			const group = readBraceGroup(src, i);
			flush();
			boxes.push(paint(parseExpr(group.text, inner())));
			i = group.end;
			continue;
		}
		if (c === "(" || c === "[") {
			const closeCh = c === "(" ? ")" : "]";
			const close = matchDelim(src, i, c, closeCh);
			if (close !== -1) {
				const innerBox = parseExpr(src.slice(i + 1, close), inner());
				if (innerBox.lines.length > 1) {
					flush();
					boxes.push(paint(delimBox(innerBox, c, closeCh)));
					i = close + 1;
					continue;
				}
			}
		}
		inline += c;
		i++;
	}
	flush();
	if (boxes.length === 0) return textBox("");
	return hconcat(boxes);
}

function splitLines(src: string): string[] {
	const lines: string[] = [];
	let braceDepth = 0;
	let envDepth = 0;
	let last = 0;
	let i = 0;
	while (i < src.length) {
		if (src.startsWith("\\begin", i)) {
			envDepth++;
			i += 6;
			continue;
		}
		if (src.startsWith("\\end", i)) {
			envDepth--;
			i += 4;
			continue;
		}
		const c = src[i];
		if (c === "\\") {
			if (src[i + 1] === "\\" && braceDepth === 0 && envDepth === 0) {
				lines.push(src.slice(last, i));
				i += 2;
				while (src[i] === " ") i++;
				if (src[i] === "[") {
					const close = src.indexOf("]", i);
					i = close === -1 ? src.length : close + 1;
				}
				last = i;
				continue;
			}
			i += 2; // escaped char — never a logical-line break
			continue;
		}
		if (c === "{") braceDepth++;
		else if (c === "}") braceDepth--;
		else if (c === "\n" && braceDepth === 0 && envDepth === 0) {
			lines.push(src.slice(last, i));
			last = i + 1;
		}
		i++;
	}
	lines.push(src.slice(last));
	return lines;
}

export function latexToBlock(src: string): string[] {
	if (typeof src !== "string" || src.trim() === "") return [];
	const rawLines = splitLines(src.trim());
	const rows: Box[] = [];
	for (let ri = 0; ri < rawLines.length; ri++) {
		const trimmed = rawLines[ri]!.trim();
		if (trimmed !== "") rows.push(parseExpr(trimmed));
	}
	if (rows.length === 0) return [];
	let lines = vconcat(rows).lines;
	while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines = lines.slice(0, -1);
	while (lines.length > 1 && lines[0].trim() === "") lines = lines.slice(1);
	return lines;
}
