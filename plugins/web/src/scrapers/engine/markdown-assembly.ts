export function renderHeader(title: string, description?: string | null): string {
	let md = `# ${title}\n\n`;
	if (description) md += `${description}\n\n`;
	return md;
}

export function renderStringList(title: string, items?: string[] | null, counted = false): string {
	if (!items || items.length === 0) return "";
	let md = `\n## ${title}${counted ? ` (${items.length})` : ""}\n\n`;
	for (const item of items) {
		md += `- ${item}\n`;
	}
	return md;
}

export function renderSimpleList<T>(
	title: string,
	items: T[] | undefined | null,
	formatItem: (item: T) => string,
	limit?: number,
): string {
	if (!items || items.length === 0) return "";
	let md = `\n## ${title}\n\n`;
	const count = limit === undefined ? items.length : Math.min(items.length, limit);
	for (let index = 0; index < count; index++) {
		md += `- ${formatItem(items[index])}\n`;
	}
	return md;
}

export function renderDescriptionSection(description?: string | null, title = "Description"): string {
	if (!description) return "";
	return `\n## ${title}\n\n${description}\n`;
}

export function renderReadme(readme?: string | null, title = "README"): string {
	if (!readme) return "";
	return `\n---\n\n## ${title}\n\n${readme}\n`;
}
export function renderKeyValues(
	entries: Array<[label: string, value: string | number | boolean | undefined | null]>,
): string {
	let md = "";
	for (const [label, value] of entries) {
		if (value !== undefined && value !== null && value !== "") {
			md += `**${label}:** ${value}\n`;
		}
	}
	return md;
}

export function renderCodeBlock(code?: string | null, lang = "bash", title?: string): string {
	if (!code || !code.trim()) return "";
	const trimmed = code.trim();
	if (title) return `\n## ${title}\n\n\`\`\`${lang}\n${trimmed}\n\`\`\`\n`;
	return `\`\`\`${lang}\n${trimmed}\n\`\`\`\n\n`;
}
