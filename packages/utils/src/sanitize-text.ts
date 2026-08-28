const ESC_CHAR = "\x1b";

const CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

const REPLACEMENT_CHAR = "\ufffd";

export function sanitizeText(text: string): string {
	const wellFormed = text.toWellFormed();
	if (wellFormed !== text) {
		return sanitizeWellFormedText(wellFormed.replaceAll(REPLACEMENT_CHAR, ""));
	}
	return sanitizeWellFormedText(text);
}

function sanitizeWellFormedText(text: string): string {
	CONTROL_RE.lastIndex = 0;
	if (CONTROL_RE.exec(text) === null) return text;

	const stripped = text.indexOf(ESC_CHAR) === -1 ? text : Bun.stripANSI(text);
	CONTROL_RE.lastIndex = 0;
	return stripped.replace(CONTROL_RE, "");
}

const MAX_PARTIAL_ESCAPE = 4096;

const BEL_CHAR = "\x07";

function isCsiParameter(char: string): boolean {
	const code = char.charCodeAt(0);
	return code >= 0x30 && code <= 0x3f;
}

function isCsiIntermediate(char: string): boolean {
	const code = char.charCodeAt(0);
	return code >= 0x20 && code <= 0x2f;
}

export function splitTrailingPartialEscape(text: string): { head: string; partial: string } {
	if (text.indexOf(ESC_CHAR) === -1) return { head: text, partial: "" };

	let state: "ground" | "esc" | "csi" | "string" | "string-esc" = "ground";
	let start = -1;
	for (let index = 0; index < text.length; index++) {
		const char = text[index] as string;
		switch (state) {
			case "ground":
				if (char === ESC_CHAR) {
					state = "esc";
					start = index;
				}
				break;
			case "esc":
				if (char === "[") state = "csi";
				else if (char === "]" || char === "P" || char === "X" || char === "^" || char === "_") state = "string";
				else {
					state = "ground";
					start = -1;
				}
				break;
			case "csi":
				if (isCsiParameter(char) || isCsiIntermediate(char)) break;
				state = "ground";
				start = -1;
				break;
			case "string":
				if (char === BEL_CHAR) {
					state = "ground";
					start = -1;
				} else if (char === ESC_CHAR) state = "string-esc";
				break;
			case "string-esc":
				if (char === "\\") {
					state = "ground";
					start = -1;
				} else state = "string";
				break;
		}
	}

	if (start === -1) return { head: text, partial: "" };
	if (text.length - start > MAX_PARTIAL_ESCAPE) return { head: text, partial: "" };
	return { head: text.slice(0, start), partial: text.slice(start) };
}

export function escapeXmlText(input: string): string {
	let firstEscapable = -1;
	for (let index = 0; index < input.length; index++) {
		const char = input.charCodeAt(index);
		if (char === 38 || char === 60 || char === 62) {
			firstEscapable = index;
			break;
		}
	}
	if (firstEscapable === -1) return input;

	let output = input.slice(0, firstEscapable);
	for (let index = firstEscapable; index < input.length; index++) {
		const char = input[index];
		if (char === "&") output += "&amp;";
		else if (char === "<") output += "&lt;";
		else if (char === ">") output += "&gt;";
		else output += char;
	}
	return output;
}

export function escapeXmlAttribute(input: string): string {
	let firstEscapable = -1;
	for (let index = 0; index < input.length; index++) {
		const char = input.charCodeAt(index);
		if (char === 38 || char === 60 || char === 62 || char === 34) {
			firstEscapable = index;
			break;
		}
	}
	if (firstEscapable === -1) return input;

	let output = input.slice(0, firstEscapable);
	for (let index = firstEscapable; index < input.length; index++) {
		const char = input[index];
		if (char === "&") output += "&amp;";
		else if (char === "<") output += "&lt;";
		else if (char === ">") output += "&gt;";
		else if (char === '"') output += "&quot;";
		else output += char;
	}
	return output;
}
