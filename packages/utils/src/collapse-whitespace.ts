export function collapseWhitespace(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}
