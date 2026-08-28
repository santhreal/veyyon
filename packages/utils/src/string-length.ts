export function codePointLength(value: string): number {
	let count = 0;
	for (const _ of value) count += 1;
	return count;
}

export function utf8ByteLength(value: string, start = 0, end = value.length): number {
	let bytes = 0;
	for (let index = start; index < end; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit <= 0x7f) {
			bytes++;
		} else if (codeUnit <= 0x7ff) {
			bytes += 2;
		} else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < end) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index++;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

export function isWellFormedUtf16(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index++;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}
	return true;
}
