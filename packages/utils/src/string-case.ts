/**
 * Convert kebab-case to camelCase (`"thinking-level"` -> `"thinkingLevel"`).
 *
 * The ONE owner of this conversion. It was previously hand-rolled privately in
 * `frontmatter.ts` (normalizing YAML keys) and again in the coding-agent's
 * system-prompt block registry (deriving the camelCase section-override keys
 * from the canonical kebab ids). Byte-identical copies still drift, and a
 * case-conversion helper belongs with the other case helpers, so both callers
 * import this.
 *
 * Only a lowercase letter after the hyphen is lifted, so a numeric or
 * already-uppercase segment (`"utf-8"`, `"X-Header"`) is left alone.
 */
export function kebabToCamel(key: string): string {
	if (!key.includes("-")) return key;
	return key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

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
