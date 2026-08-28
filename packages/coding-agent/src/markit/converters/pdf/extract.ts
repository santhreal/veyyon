import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFileSync } from "@veyyon/utils/atomic-write";
import { getAgentDir } from "@veyyon/utils/dirs";
import { errorMessage } from "@veyyon/utils/type-guards";
import type * as mupdf from "mupdf";
import { type EmbeddedMupdfModuleFiles, loadEmbeddedMupdfModuleFiles } from "../../../utils/mupdf-wasm-embed";
import type { ImageRegion, PageContent, Segment, TextBox } from "./types";

let mupdfModule: typeof mupdf | undefined;

export function materializeEmbeddedMupdf(embedded: EmbeddedMupdfModuleFiles): string {
	const cacheDir = path.join(getAgentDir(), "cache", "mupdf", embedded.version);
	const targets = [
		{ asset: embedded.mupdfJs, name: "mupdf.js" },
		{ asset: embedded.mupdfWasmJs, name: "mupdf-wasm.js" },
	];
	for (const { asset, name } of targets) {
		const target = path.join(cacheDir, name);
		const bytes = fs.readFileSync(asset);
		if (cachedFileMatches(target, bytes)) continue;
		atomicWriteFileSync(target, bytes);
	}
	return path.join(cacheDir, "mupdf.js");
}

function cachedFileMatches(target: string, bytes: Buffer): boolean {
	let existing: Buffer;
	try {
		existing = fs.readFileSync(target);
	} catch {
		return false;
	}
	return existing.length === bytes.length && existing.equals(bytes);
}

async function loadMupdf(): Promise<typeof mupdf> {
	if (!mupdfModule) {
		const embedded = loadEmbeddedMupdfModuleFiles();
		if (embedded) {
			let entry: string;
			try {
				entry = materializeEmbeddedMupdf(embedded);
			} catch (err) {
				throw new Error(
					`Failed to materialize the embedded mupdf runtime under ${path.join(getAgentDir(), "cache", "mupdf")}: ` +
						`${errorMessage(err)}. ` +
						`PDF conversion needs a writable agent cache dir — check permissions/disk space, or remove the dir to force a rewrite.`,
					{ cause: err },
				);
			}
			mupdfModule = (await import(entry)) as typeof mupdf;
		} else {
			mupdfModule = await import("mupdf");
		}
	}
	return mupdfModule;
}

interface StextBBox {
	x: number;
	y: number;
	w: number;
	h: number;
}

interface StextFont {
	size?: number;
	weight?: string;
	name?: string;
}

interface StextLine {
	text?: string;
	font?: StextFont;
	bbox: StextBBox;
}

interface StextBlock {
	type: string;
	bbox: StextBBox;
	lines: StextLine[];
}

interface StructuredTextJSON {
	blocks: StextBlock[];
}

interface RawTextItem {
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
	fontSize: number;
	isBold: boolean;
}

const SAME_LINE_Y_TOLERANCE = 2;
const MAX_MERGE_GAP = 14;

function mergeIntoWords(raws: RawTextItem[]): RawTextItem[] {
	if (raws.length === 0) return [];
	const sorted = raws.slice().sort((a, b) => {
		const dy = b.y - a.y;
		return Math.abs(dy) > SAME_LINE_Y_TOLERANCE ? dy : a.x - b.x;
	});
	const merged: RawTextItem[] = [];
	let cur = { ...sorted[0] };
	for (let i = 1; i < sorted.length; i++) {
		const next = sorted[i];
		const sameY = Math.abs(next.y - cur.y) <= SAME_LINE_Y_TOLERANCE;
		const close = next.x <= cur.x + cur.width + MAX_MERGE_GAP;
		if (sameY && close) {
			const gap = next.x - (cur.x + cur.width);
			const sep = gap > 1 ? " " : "";
			cur.text += sep + next.text;
			cur.width = next.x + next.width - cur.x;
			cur.height = Math.max(cur.height, next.height);
			cur.fontSize = Math.max(cur.fontSize, next.fontSize);
			cur.isBold = cur.isBold || next.isBold;
		} else {
			merged.push(cur);
			cur = { ...next };
		}
	}
	merged.push(cur);
	return merged;
}

function extractTextBoxes(
	page: mupdf.Page,
	pageNumber: number,
	pageHeight: number,
	stext?: StructuredTextJSON,
): TextBox[] {
	if (!stext) {
		stext = JSON.parse(page.toStructuredText("preserve-whitespace").asJSON()) as StructuredTextJSON;
	}
	const raws: RawTextItem[] = [];
	for (const block of stext.blocks) {
		if (block.type !== "text") continue;
		for (const line of block.lines) {
			const text = line.text?.trim();
			if (!text) continue;
			const fontSize = line.font?.size ?? 0;
			const weight = line.font?.weight ?? "normal";
			const fontName = line.font?.name ?? "";
			const isBold = weight === "bold" || /bold/i.test(fontName) || /Black|Heavy/i.test(fontName);
			const bboxY = line.bbox.y;
			const bboxH = line.bbox.h;
			const pdfY = pageHeight - (bboxY + bboxH);
			raws.push({
				text,
				x: line.bbox.x,
				y: pdfY,
				width: line.bbox.w,
				height: bboxH,
				fontSize,
				isBold,
			});
		}
	}
	const words = mergeIntoWords(raws);
	return words
		.map((w, i) => ({
			id: `p${pageNumber}-t${i}`,
			text: w.text.trim(),
			pageNumber,
			fontSize: w.fontSize,
			isBold: w.isBold,
			bounds: {
				left: w.x,
				right: w.x + w.width,
				bottom: w.y,
				top: w.y + w.height,
			},
		}))
		.filter(b => b.text.length > 0);
}

const LINE_ASPECT_THRESHOLD = 6;
const MIN_LENGTH = 2;
const MAX_THICKNESS = 3;

function thinRectToSegment(id: string, x: number, y: number, w: number, h: number): Segment | null {
	const aw = Math.abs(w);
	const ah = Math.abs(h);
	if (aw > ah * LINE_ASPECT_THRESHOLD && aw >= MIN_LENGTH && ah <= MAX_THICKNESS) {
		const cy = y + ah / 2;
		return { id, x1: x, y1: cy, x2: x + aw, y2: cy };
	}
	if (ah > aw * LINE_ASPECT_THRESHOLD && ah >= MIN_LENGTH && aw <= MAX_THICKNESS) {
		const cx = x + aw / 2;
		return { id, x1: cx, y1: y, x2: cx, y2: y + ah };
	}
	return null;
}

function pushStrokedRectEdges(segments: Segment[], id: string, x: number, y: number, w: number, h: number): void {
	const aw = Math.abs(w);
	const ah = Math.abs(h);
	const base = id;
	if (aw >= MIN_LENGTH) {
		segments.push({ id: `${base}-b`, x1: x, y1: y, x2: x + aw, y2: y });
		segments.push({
			id: `${base}-t`,
			x1: x,
			y1: y + ah,
			x2: x + aw,
			y2: y + ah,
		});
	}
	if (ah >= MIN_LENGTH) {
		segments.push({ id: `${base}-l`, x1: x, y1: y, x2: x, y2: y + ah });
		segments.push({
			id: `${base}-r`,
			x1: x + aw,
			y1: y,
			x2: x + aw,
			y2: y + ah,
		});
	}
}

const CTM_IDENTITY = [1, 0, 0, 1, 0, 0];

function ctmConcat(p: number[], c: number[]): number[] {
	return [
		p[0] * c[0] + p[2] * c[1],
		p[1] * c[0] + p[3] * c[1],
		p[0] * c[2] + p[2] * c[3],
		p[1] * c[2] + p[3] * c[3],
		p[0] * c[4] + p[2] * c[5] + p[4],
		p[1] * c[4] + p[3] * c[5] + p[5],
	];
}

function ctmApply(m: number[], x: number, y: number): [number, number] {
	return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function extractSegmentsFromContentStream(raw: string, pageNumber: number): Segment[] {
	const segments: Segment[] = [];
	const tokens = tokenizeContentStream(raw);
	let idx = 0;
	let strokeWidth = 1.0;
	let ctm = CTM_IDENTITY.slice();
	const stateStack: Array<{ ctm: number[]; strokeWidth: number }> = [];
	let curX = 0;
	let curY = 0;
	let pathStartX = 0;
	let pathStartY = 0;
	const pendingRects: Array<{ x: number; y: number; w: number; h: number }> = [];
	const pendingLines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
	function flushPath(mode: "fill" | "stroke"): void {
		const sid = () => `p${pageNumber}-s${segments.length}`;
		if (mode === "fill") {
			for (const r of pendingRects) {
				const [x0, y0] = ctmApply(ctm, r.x, r.y);
				const [x1, y1] = ctmApply(ctm, r.x + r.w, r.y + r.h);
				const seg = thinRectToSegment(
					sid(),
					Math.min(x0, x1),
					Math.min(y0, y1),
					Math.abs(x1 - x0),
					Math.abs(y1 - y0),
				);
				if (seg) segments.push(seg);
			}
		} else if (mode === "stroke" && strokeWidth <= MAX_THICKNESS) {
			for (const r of pendingRects) {
				const [x0, y0] = ctmApply(ctm, r.x, r.y);
				const [x1, y1] = ctmApply(ctm, r.x + r.w, r.y + r.h);
				pushStrokedRectEdges(
					segments,
					sid(),
					Math.min(x0, x1),
					Math.min(y0, y1),
					Math.abs(x1 - x0),
					Math.abs(y1 - y0),
				);
			}
			for (const l of pendingLines) {
				const [lx1, ly1] = ctmApply(ctm, l.x1, l.y1);
				const [lx2, ly2] = ctmApply(ctm, l.x2, l.y2);
				const dx = Math.abs(lx2 - lx1);
				const dy = Math.abs(ly2 - ly1);
				if ((dx >= MIN_LENGTH && dy < 1) || (dy >= MIN_LENGTH && dx < 1)) {
					segments.push({ id: sid(), x1: lx1, y1: ly1, x2: lx2, y2: ly2 });
				}
			}
		}
		pendingRects.length = 0;
		pendingLines.length = 0;
	}
	while (idx < tokens.length) {
		const t = tokens[idx];
		if (t === "q") {
			stateStack.push({ ctm: ctm.slice(), strokeWidth });
		} else if (t === "Q") {
			const saved = stateStack.pop();
			if (saved) {
				ctm = saved.ctm;
				strokeWidth = saved.strokeWidth;
			}
		} else if (t === "cm" && idx >= 6) {
			const a = Number(tokens[idx - 6]);
			const b = Number(tokens[idx - 5]);
			const c = Number(tokens[idx - 4]);
			const d = Number(tokens[idx - 3]);
			const e = Number(tokens[idx - 2]);
			const f = Number(tokens[idx - 1]);
			ctm = ctmConcat(ctm, [a, b, c, d, e, f]);
		} else if (t === "w" && idx >= 1) {
			const width = Number(tokens[idx - 1]);
			if (Number.isFinite(width)) strokeWidth = width;
		} else if (t === "re" && idx >= 4) {
			const x = Number(tokens[idx - 4]);
			const y = Number(tokens[idx - 3]);
			const w = Number(tokens[idx - 2]);
			const h = Number(tokens[idx - 1]);
			if (Number.isFinite(x + y + w + h)) {
				pendingRects.push({ x, y, w, h });
			}
		} else if (t === "m" && idx >= 2) {
			curX = Number(tokens[idx - 2]);
			curY = Number(tokens[idx - 1]);
			pathStartX = curX;
			pathStartY = curY;
		} else if (t === "l" && idx >= 2) {
			const x2 = Number(tokens[idx - 2]);
			const y2 = Number(tokens[idx - 1]);
			pendingLines.push({ x1: curX, y1: curY, x2, y2 });
			curX = x2;
			curY = y2;
		} else if (t === "h") {
			if (curX !== pathStartX || curY !== pathStartY) {
				pendingLines.push({
					x1: curX,
					y1: curY,
					x2: pathStartX,
					y2: pathStartY,
				});
			}
			curX = pathStartX;
			curY = pathStartY;
		} else if (t === "f" || t === "F" || t === "f*") {
			flushPath("fill");
		} else if (t === "S" || t === "s") {
			if (t === "s") {
				if (curX !== pathStartX || curY !== pathStartY) {
					pendingLines.push({
						x1: curX,
						y1: curY,
						x2: pathStartX,
						y2: pathStartY,
					});
				}
			}
			flushPath("stroke");
		} else if (t === "B" || t === "B*" || t === "b" || t === "b*") {
			flushPath("fill");
			flushPath("stroke");
		} else if (t === "n") {
			pendingRects.length = 0;
			pendingLines.length = 0;
		}
		idx++;
	}
	return segments;
}

function tokenizeContentStream(raw: string): string[] {
	const tokens: string[] = [];
	const len = raw.length;
	let i = 0;
	let inInlineImage = false;
	while (i < len) {
		const ch = raw.charCodeAt(i);
		if (ch <= 32) {
			i++;
			continue;
		}
		if (ch === 37 /* % */) {
			while (i < len && raw.charCodeAt(i) !== 10) i++;
			continue;
		}
		if (ch === 40 /* ( */) {
			let depth = 1;
			i++;
			while (i < len && depth > 0) {
				const c = raw.charCodeAt(i);
				if (c === 92 /* \ */) {
					i++;
				} else if (c === 40) {
					depth++;
				} else if (c === 41) {
					depth--;
				}
				i++;
			}
			continue;
		}
		if (ch === 60 /* < */ && i + 1 < len && raw.charCodeAt(i + 1) !== 60) {
			i++;
			while (i < len && raw.charCodeAt(i) !== 62) i++;
			i++; // skip >
			continue;
		}
		if (ch === 60 && i + 1 < len && raw.charCodeAt(i + 1) === 60) {
			i += 2;
			continue;
		}
		if (ch === 62 && i + 1 < len && raw.charCodeAt(i + 1) === 62) {
			i += 2;
			continue;
		}
		if (ch === 41 || ch === 62) {
			i++;
			continue;
		}
		const start = i;
		while (i < len) {
			const c = raw.charCodeAt(i);
			if (c <= 32 || c === 40 || c === 41 || c === 60 || c === 62 || c === 37) break;
			i++;
		}
		if (i > start) {
			const token = raw.substring(start, i);
			tokens.push(token);
			if (token === "BI") {
				inInlineImage = true;
			} else if (token === "ID" && inInlineImage) {
				while (i < len && raw.charCodeAt(i) <= 32) i++;
				while (i < len) {
					const c = raw.charCodeAt(i);
					const prev = i === 0 ? 32 : raw.charCodeAt(i - 1);
					const next = i + 2 >= len ? 32 : raw.charCodeAt(i + 2);
					if (c === 69 && raw.charCodeAt(i + 1) === 73 && prev <= 32 && next <= 32) {
						i += 2;
						break;
					}
					i++;
				}
				inInlineImage = false;
			}
		}
	}
	return tokens;
}

const MIN_IMAGE_AREA = 5000;

function extractImageRegions(stext: StructuredTextJSON, pageNumber: number, pageHeight: number): ImageRegion[] {
	const regions: ImageRegion[] = [];
	for (const block of stext.blocks) {
		if (block.type !== "image") continue;
		const { x, y, w, h } = block.bbox;
		if (w * h < MIN_IMAGE_AREA) continue; // skip tiny icons
		const pdfTopY = pageHeight - y;
		regions.push({
			id: `p${pageNumber}-img${regions.length}`,
			pageNumber,
			bbox: { x, y, w, h },
			topY: pdfTopY,
		});
	}
	return regions;
}

export async function renderImageRegion(input: Uint8Array, region: ImageRegion): Promise<Uint8Array> {
	const m = await loadMupdf();
	const doc = m.Document.openDocument(input, "application/pdf");
	const page = doc.loadPage(region.pageNumber - 1);
	const pad = 10;
	const bx = region.bbox.x - pad;
	const by = region.bbox.y - pad;
	const bw = region.bbox.w + 2 * pad;
	const bh = region.bbox.h + 2 * pad;
	const scale = 2;
	const pw = Math.round(bw * scale);
	const ph = Math.round(bh * scale);
	const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, pw, ph], false);
	pix.clear(255);
	const matrix: mupdf.Matrix = [scale, 0, 0, scale, -bx * scale, -by * scale];
	const dl = page.toDisplayList();
	const dev = new m.DrawDevice(matrix, pix);
	dl.run(dev, m.Matrix.identity);
	dev.close();
	return pix.asPNG();
}

export async function extractPages(input: Uint8Array): Promise<PageContent[]> {
	const m = await loadMupdf();
	const doc = m.Document.openDocument(input, "application/pdf");
	const pages: PageContent[] = [];
	for (let i = 0; i < doc.countPages(); i++) {
		const pageNumber = i + 1;
		const page = doc.loadPage(i);
		const bounds = page.getBounds();
		const pageHeight = bounds[3] - bounds[1];
		const stext = JSON.parse(
			page.toStructuredText("preserve-whitespace,preserve-images").asJSON(),
		) as StructuredTextJSON;
		const textBoxes = extractTextBoxes(page, pageNumber, pageHeight, stext);
		const images = extractImageRegions(stext, pageNumber, pageHeight);
		let segments: Segment[] = [];
		try {
			const pageObj = (page as mupdf.PDFPage).getObject();
			const contents = pageObj.get("Contents");
			if (contents) {
				let rawBytes: Uint8Array;
				if (contents.isArray()) {
					const parts: Uint8Array[] = [];
					const len = contents.length ?? 0;
					for (let j = 0; j < len; j++) {
						const stream = contents.get(j);
						if (stream?.readStream) {
							parts.push(stream.readStream().asUint8Array());
						}
					}
					const totalLen = parts.reduce((s, p) => s + p.length, 0);
					rawBytes = new Uint8Array(totalLen);
					let offset = 0;
					for (const part of parts) {
						rawBytes.set(part, offset);
						offset += part.length;
					}
				} else {
					rawBytes = contents.readStream().asUint8Array();
				}
				const raw = new TextDecoder().decode(rawBytes);
				segments = extractSegmentsFromContentStream(raw, pageNumber);
			}
		} catch {}
		pages.push({ pageNumber, textBoxes, segments, images });
	}
	return pages;
}
