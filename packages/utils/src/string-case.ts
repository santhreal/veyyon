/** Uppercase the first letter of every whitespace-separated word. */
export function titleCaseWords(text: string): string {
	return text
		.split(/\s+/)
		.filter(Boolean)
		.map(word => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}

/** Capitalize first letter only — keeps acronyms / casing in the rest of the sentence intact. */
export function titleCaseSentence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return trimmed;
	return trimmed[0].toUpperCase() + trimmed.slice(1);
}
