import { clamp, clamp01 } from "@veyyon/utils/math";
import { sgrSequence } from "./ansi";
import { parseHexColor } from "./paint-ground";

export const CHANNEL_STR: readonly string[] = Array.from({ length: 256 }, (_, i) => String(i));

const HEX_BYTE: readonly string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function clampChannel(value: number): number {
	return clamp(Math.round(value), 0, 255);
}

export function toHexColor(r: number, g: number, b: number): string {
	return `#${HEX_BYTE[clampChannel(r)]}${HEX_BYTE[clampChannel(g)]}${HEX_BYTE[clampChannel(b)]}`;
}

export function blendHex(from: string, to: string, t: number): string {
	const a = parseHexColor(from);
	const b = parseHexColor(to);
	if (a === null || b === null) return t >= 0.5 ? to : from;
	const k = clamp01(t);
	return toHexColor(a.r + (b.r - a.r) * k, a.g + (b.g - a.g) * k, a.b + (b.b - a.b) * k);
}

const SGR = sgrSequence("g");

function parseSgrInt(s: string, start: number, len: number): number {
	let n = 0;
	for (let k = 0; k < len; k++) {
		const c = s.charCodeAt(start + k);
		if (c < 48 || c > 57) return -1;
		n = n * 10 + (c - 48);
	}
	return n;
}

function fadeLineWithParsedGround(line: string, gr: number, gg: number, gb: number, k: number): string {
	if (
		line.indexOf("38;2;") === -1 &&
		line.indexOf("48;2;") === -1 &&
		line.indexOf("38:2:") === -1 &&
		line.indexOf("48:2:") === -1
	) {
		return line;
	}
	SGR.lastIndex = 0;
	return line.replace(SGR, (whole, params: string) => {
		if (params === "") return whole;
		if (
			params.indexOf("38;2;") === -1 &&
			params.indexOf("48;2;") === -1 &&
			params.indexOf("38:2:") === -1 &&
			params.indexOf("48:2:") === -1
		) {
			return whole;
		}
		let out = "";
		let changed = false;
		let i = 0;
		const n = params.length;
		while (i < n) {
			let j = i;
			while (j < n && params.charCodeAt(j) !== 0x3b && params.charCodeAt(j) !== 0x3a) j++;
			const tokLen = j - i;
			if (
				tokLen === 2 &&
				params.charCodeAt(i + 1) === 0x38 &&
				(params.charCodeAt(i) === 0x33 || params.charCodeAt(i) === 0x34) &&
				j < n
			) {
				let k2 = j + 1;
				while (k2 < n && params.charCodeAt(k2) !== 0x3b && params.charCodeAt(k2) !== 0x3a) k2++;
				if (k2 - (j + 1) === 1 && params.charCodeAt(j + 1) === 0x32 && k2 < n) {
					let pos = k2;
					let rVal = -1;
					let gVal = -1;
					let bVal = -1;
					let sep0 = "";
					let sep1 = "";
					let sep2 = "";
					for (let c = 0; c < 3; c++) {
						if (pos >= n) {
							rVal = -1;
							break;
						}
						const sep = params[pos]!;
						pos++;
						let valEnd = pos;
						while (valEnd < n && params.charCodeAt(valEnd) !== 0x3b && params.charCodeAt(valEnd) !== 0x3a)
							valEnd++;
						const val = parseSgrInt(params, pos, valEnd - pos);
						if (val < 0) {
							rVal = -1;
							break;
						}
						if (c === 0) {
							rVal = val;
							sep0 = sep;
						} else if (c === 1) {
							gVal = val;
							sep1 = sep;
						} else {
							bVal = val;
							sep2 = sep;
						}
						pos = valEnd;
					}
					if (rVal >= 0 && gVal >= 0 && bVal >= 0) {
						out += `${params.slice(i, j) + params[j]}2`;
						out += sep0 + CHANNEL_STR[clampChannel(gr + (rVal - gr) * k)]!;
						out += sep1 + CHANNEL_STR[clampChannel(gg + (gVal - gg) * k)]!;
						out += sep2 + CHANNEL_STR[clampChannel(gb + (bVal - gb) * k)]!;
						changed = true;
						i = pos;
						continue;
					}
				}
			}
			out += params.slice(i, j);
			if (j < n) out += params[j];
			i = j + 1;
		}
		return changed ? `\x1b[${out}m` : whole;
	});
}

export function fadeLineTowards(line: string, groundHex: string, strength: number): string {
	const k = clamp01(strength);
	if (k >= 1) return line;
	const ground = parseHexColor(groundHex);
	if (ground === null) return line;
	return fadeLineWithParsedGround(line, ground.r, ground.g, ground.b, k);
}

export function fadeLinesTowards(lines: readonly string[], groundHex: string, strength: number): string[] {
	if (strength >= 1) return lines.slice();
	const k = clamp01(strength);
	const ground = parseHexColor(groundHex);
	if (ground === null) return lines.slice();
	const result = new Array<string>(lines.length);
	for (let li = 0; li < lines.length; li++) {
		result[li] = fadeLineWithParsedGround(lines[li]!, ground.r, ground.g, ground.b, k);
	}
	return result;
}

export function revealedRows(total: number, progress: number, minimum = 0): number {
	if (total <= 0) return 0;
	const floor = Math.min(minimum, total);
	const shown = Math.min(total, Math.round(total * clamp01(progress)));
	return Math.max(floor, shown);
}
