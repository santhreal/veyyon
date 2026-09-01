import type { QrEcLevel, QrEncodeOptions } from "./qrcode-helpers";

export type { QrEcLevel } from "./qrcode-helpers";

import {
	BYTE_MODE_INDICATOR,
	charCountBits,
	dataCodewords,
	EC_LEVELS,
	ECC_CODEWORDS_PER_BLOCK,
	getBit,
	MAX_VERSION,
	MIN_VERSION,
	maskBit,
	NUM_EC_BLOCKS,
	PAD_BYTES,
	PENALTY_N1,
	PENALTY_N2,
	PENALTY_N3,
	PENALTY_N4,
	rawDataModules,
	rsDivisor,
	rsRemainder,
} from "./qrcode-helpers";

export class QrCode {
	readonly size: number;
	readonly mask: number;
	readonly #modules: boolean[][];
	readonly #isFunction: boolean[][];

	private constructor(
		readonly version: number,
		readonly ecLevel: QrEcLevel,
		dataCodewordsInterleaved: Uint8Array,
		mask: number,
	) {
		this.size = version * 4 + 17;
		this.#modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
		this.#isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));

		this.#drawFunctionPatterns();
		this.#drawCodewords(dataCodewordsInterleaved);
		this.mask = this.#selectMask(mask);
	}

	module(x: number, y: number): boolean {
		return this.#modules[y]![x]!;
	}

	static encodeText(text: string, ecLevel: QrEcLevel = "M", options?: QrEncodeOptions): QrCode {
		return QrCode.encodeBytes(new TextEncoder().encode(text), ecLevel, options);
	}

	static encodeBytes(data: Uint8Array, ecLevel: QrEcLevel = "M", options?: QrEncodeOptions): QrCode {
		const ec = EC_LEVELS[ecLevel];
		const minVersion = Math.max(MIN_VERSION, options?.minVersion ?? MIN_VERSION);
		const maxVersion = Math.min(MAX_VERSION, options?.maxVersion ?? MAX_VERSION);

		let version = minVersion;
		for (; ; version++) {
			const capacityBits = dataCodewords(version, ec.table) * 8;
			const usedBits = 4 + charCountBits(version) + data.length * 8;
			if (usedBits <= capacityBits) break;
			if (version >= maxVersion) {
				throw new Error(`data too long for a QR code (${data.length} bytes, EC ${ecLevel})`);
			}
		}

		const bits = new BitBuffer();
		bits.append(BYTE_MODE_INDICATOR, 4);
		bits.append(data.length, charCountBits(version));
		for (const b of data) bits.append(b, 8);

		const capacityBits = dataCodewords(version, ec.table) * 8;
		bits.append(0, Math.min(4, capacityBits - bits.length)); // terminator
		bits.append(0, (8 - (bits.length % 8)) % 8); // byte-align
		for (let pad = 0; bits.length < capacityBits; pad ^= 1) bits.append(PAD_BYTES[pad]!, 8);

		const codewords = QrCode.#interleave(bits.toBytes(), version, ec.table);
		const mask = options?.mask ?? -1;
		if (mask < -1 || mask > 7) throw new Error(`invalid mask ${mask}`);
		return new QrCode(version, ecLevel, codewords, mask);
	}

	static #interleave(data: Uint8Array, version: number, ecTable: number): Uint8Array {
		const numBlocks = NUM_EC_BLOCKS[ecTable]![version]!;
		const eccLen = ECC_CODEWORDS_PER_BLOCK[ecTable]![version]!;
		const rawCodewords = Math.floor(rawDataModules(version) / 8);
		const numShort = numBlocks - (rawCodewords % numBlocks);
		const shortLen = Math.floor(rawCodewords / numBlocks);
		const divisor = rsDivisor(eccLen);

		const blocks: Uint8Array[] = [];
		const blockLen = shortLen + 1;
		for (let i = 0, offset = 0; i < numBlocks; i++) {
			const datLen = shortLen - eccLen + (i < numShort ? 0 : 1);
			const dat = data.subarray(offset, offset + datLen);
			offset += datLen;
			const block = new Uint8Array(blockLen);
			block.set(dat, 0);
			block.set(rsRemainder(dat, divisor), blockLen - eccLen);
			blocks.push(block);
		}

		const result = new Uint8Array(rawCodewords);
		let w = 0;
		for (let i = 0; i < blockLen; i++) {
			for (let b = 0; b < numBlocks; b++) {
				if (i === shortLen - eccLen && b < numShort) continue;
				result[w++] = blocks[b]![i]!;
			}
		}
		return result;
	}

	#setFunction(x: number, y: number, dark: boolean): void {
		this.#modules[y]![x] = dark;
		this.#isFunction[y]![x] = true;
	}

	#drawFunctionPatterns(): void {
		for (let i = 0; i < this.size; i++) {
			this.#setFunction(6, i, i % 2 === 0);
			this.#setFunction(i, 6, i % 2 === 0);
		}
		this.#drawFinder(3, 3);
		this.#drawFinder(this.size - 4, 3);
		this.#drawFinder(3, this.size - 4);

		const align = this.#alignmentPositions();
		const last = align.length - 1;
		for (let i = 0; i <= last; i++) {
			for (let j = 0; j <= last; j++) {
				if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
				this.#drawAlignment(align[i]!, align[j]!);
			}
		}

		this.#drawFormatBits(0); // placeholder until mask chosen
		this.#drawVersion();
	}

	#drawFinder(cx: number, cy: number): void {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const dist = Math.max(Math.abs(dx), Math.abs(dy));
				const x = cx + dx;
				const y = cy + dy;
				if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
					this.#setFunction(x, y, dist !== 2 && dist !== 4);
				}
			}
		}
	}

	#drawAlignment(cx: number, cy: number): void {
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++) {
				this.#setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
			}
		}
	}

	#alignmentPositions(): number[] {
		if (this.version === 1) return [];
		const numAlign = Math.floor(this.version / 7) + 2;
		const step = this.version === 32 ? 26 : Math.ceil((this.size - 13) / (numAlign * 2 - 2)) * 2;
		const result = [6];
		for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
		return result;
	}

	#drawFormatBits(mask: number): void {
		const data = (EC_LEVELS[this.ecLevel].formatBits << 3) | mask;
		let rem = data;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const bits = ((data << 10) | rem) ^ 0x5412;

		for (let i = 0; i <= 5; i++) this.#setFunction(8, i, getBit(bits, i));
		this.#setFunction(8, 7, getBit(bits, 6));
		this.#setFunction(8, 8, getBit(bits, 7));
		this.#setFunction(7, 8, getBit(bits, 8));
		for (let i = 9; i < 15; i++) this.#setFunction(14 - i, 8, getBit(bits, i));

		for (let i = 0; i < 8; i++) this.#setFunction(this.size - 1 - i, 8, getBit(bits, i));
		for (let i = 8; i < 15; i++) this.#setFunction(8, this.size - 15 + i, getBit(bits, i));
		this.#setFunction(8, this.size - 8, true); // always-dark module
	}

	#drawVersion(): void {
		if (this.version < 7) return;
		let rem = this.version;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		const bits = (this.version << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const bit = getBit(bits, i);
			const a = this.size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			this.#setFunction(a, b, bit);
			this.#setFunction(b, a, bit);
		}
	}

	#drawCodewords(data: Uint8Array): void {
		let i = 0;
		const totalBits = data.length * 8;
		for (let right = this.size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (let vert = 0; vert < this.size; vert++) {
				for (let j = 0; j < 2; j++) {
					const x = right - j;
					const upward = ((right + 1) & 2) === 0;
					const y = upward ? this.size - 1 - vert : vert;
					if (!this.#isFunction[y]![x] && i < totalBits) {
						this.#modules[y]![x] = getBit(data[i >>> 3]!, 7 - (i & 7));
						i++;
					}
				}
			}
		}
	}

	#applyMask(mask: number): void {
		for (let y = 0; y < this.size; y++) {
			for (let x = 0; x < this.size; x++) {
				if (!this.#isFunction[y]![x] && maskBit(mask, x, y)) {
					this.#modules[y]![x] = !this.#modules[y]![x];
				}
			}
		}
	}

	#selectMask(forced: number): number {
		let mask = forced;
		if (mask === -1) {
			let minPenalty = Infinity;
			for (let m = 0; m < 8; m++) {
				this.#applyMask(m);
				this.#drawFormatBits(m);
				const penalty = this.#penaltyScore();
				if (penalty < minPenalty) {
					mask = m;
					minPenalty = penalty;
				}
				this.#applyMask(m); // undo (XOR mask is self-inverse)
			}
		}
		this.#applyMask(mask);
		this.#drawFormatBits(mask);
		return mask;
	}

	#penaltyScore(): number {
		let result = 0;
		const size = this.size;
		const mods = this.#modules;

		for (let y = 0; y < size; y++) {
			let runColor = false;
			let runLen = 0;
			const history = [0, 0, 0, 0, 0, 0, 0];
			for (let x = 0; x < size; x++) {
				if (mods[y]![x] === runColor) {
					runLen++;
					if (runLen === 5) result += PENALTY_N1;
					else if (runLen > 5) result++;
				} else {
					this.#finderAddHistory(runLen, history);
					if (!runColor) result += this.#finderCountPatterns(history) * PENALTY_N3;
					runColor = mods[y]![x]!;
					runLen = 1;
				}
			}
			result += this.#finderTerminate(runColor, runLen, history) * PENALTY_N3;
		}
		for (let x = 0; x < size; x++) {
			let runColor = false;
			let runLen = 0;
			const history = [0, 0, 0, 0, 0, 0, 0];
			for (let y = 0; y < size; y++) {
				if (mods[y]![x] === runColor) {
					runLen++;
					if (runLen === 5) result += PENALTY_N1;
					else if (runLen > 5) result++;
				} else {
					this.#finderAddHistory(runLen, history);
					if (!runColor) result += this.#finderCountPatterns(history) * PENALTY_N3;
					runColor = mods[y]![x]!;
					runLen = 1;
				}
			}
			result += this.#finderTerminate(runColor, runLen, history) * PENALTY_N3;
		}

		for (let y = 0; y < size - 1; y++) {
			for (let x = 0; x < size - 1; x++) {
				const c = mods[y]![x];
				if (c === mods[y]![x + 1] && c === mods[y + 1]![x] && c === mods[y + 1]![x + 1]) {
					result += PENALTY_N2;
				}
			}
		}

		let dark = 0;
		for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (mods[y]![x]) dark++;
		const total = size * size;
		const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
		result += k * PENALTY_N4;
		return result;
	}

	#finderCountPatterns(history: readonly number[]): number {
		const n = history[1]!;
		const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
		return (
			(core && history[0]! >= n * 4 && history[6]! >= n ? 1 : 0) +
			(core && history[6]! >= n * 4 && history[0]! >= n ? 1 : 0)
		);
	}

	#finderAddHistory(runLen: number, history: number[]): void {
		if (history[0] === 0) runLen += this.size; // light border before the first run
		history.pop();
		history.unshift(runLen);
	}

	#finderTerminate(runColor: boolean, runLen: number, history: number[]): number {
		if (runColor) {
			this.#finderAddHistory(runLen, history);
			runLen = 0;
		}
		runLen += this.size; // light border after the final run
		this.#finderAddHistory(runLen, history);
		return this.#finderCountPatterns(history);
	}
}

class BitBuffer {
	#bits: number[] = [];

	get length(): number {
		return this.#bits.length;
	}

	append(value: number, count: number): void {
		for (let i = count - 1; i >= 0; i--) this.#bits.push((value >>> i) & 1);
	}

	toBytes(): Uint8Array {
		const out = new Uint8Array(this.#bits.length >>> 3);
		for (let i = 0; i < this.#bits.length; i++) out[i >>> 3] = (out[i >>> 3]! << 1) | this.#bits[i]!;
		return out;
	}
}

export interface QrRenderOptions {
	margin?: number;
}

const ANSI_RESET = "\x1b[0m";
const ANSI_QR_ROW_PREFIX = "\x1b[47m\x1b[30m"; // white background, black foreground

export function renderQrHalfBlocks(qr: QrCode, options?: QrRenderOptions): string[] {
	const margin = Math.max(0, options?.margin ?? 4);
	const dim = qr.size + margin * 2;
	const dark = (gx: number, gy: number): boolean => {
		const x = gx - margin;
		const y = gy - margin;
		return x >= 0 && x < qr.size && y >= 0 && y < qr.size && qr.module(x, y);
	};

	const lines: string[] = [];
	for (let gy = 0; gy < dim; gy += 2) {
		let row = ANSI_QR_ROW_PREFIX;
		for (let gx = 0; gx < dim; gx++) {
			const top = dark(gx, gy);
			const bottom = gy + 1 < dim && dark(gx, gy + 1);
			row += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
		}
		lines.push(row + ANSI_RESET);
	}
	return lines;
}
