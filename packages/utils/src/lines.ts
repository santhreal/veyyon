export function splitTextLines(text: string): string[] {
	return text.split("\n").filter((line, idx, arr) => idx < arr.length - 1 || line);
}
