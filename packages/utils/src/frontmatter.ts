import { truncate } from "./format";
import { normalizeKeys, parseYamlRecord, quoteAmbiguousPlainScalars, stripHtmlComments } from "./frontmatter-helpers";
import * as logger from "./logger";

export class FrontmatterError extends Error {
	constructor(
		error: Error,
		readonly source?: unknown,
	) {
		super(`Failed to parse YAML frontmatter (${source}): ${error.message}`, { cause: error });
		this.name = "FrontmatterError";
	}

	toString(): string {
		const details: string[] = [this.message];
		if (this.source !== undefined) {
			details.push(`Source: ${JSON.stringify(this.source)}`);
		}
		if (this.cause && typeof this.cause === "object" && "stack" in this.cause && this.cause.stack) {
			details.push(`Stack:\n${this.cause.stack}`);
		} else if (this.stack) {
			details.push(`Stack:\n${this.stack}`);
		}
		return details.join("\n\n");
	}
}

export interface FrontmatterOptions {
	location?: unknown;
	source?: unknown;
	fallback?: Record<string, unknown>;
	normalize?: boolean;
	level?: "off" | "warn" | "fatal";
}

export function parseFrontmatter(
	content: string,
	options?: FrontmatterOptions,
): { frontmatter: Record<string, unknown>; body: string } {
	const { location, source, fallback, normalize = true, level = "warn" } = options ?? {};
	const loc = location ?? source;
	const frontmatter: Record<string, unknown> = { ...fallback };

	const normalized = normalize ? stripHtmlComments(content.replace(/\r\n?/g, "\n")) : content;
	if (!normalized.startsWith("---")) {
		return { frontmatter, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter, body: normalized };
	}

	const metadata = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	try {
		const loaded = parseYamlRecord(metadata);
		return { frontmatter: normalizeKeys({ ...frontmatter, ...loaded }), body };
	} catch (error) {
		const quotedMetadata = quoteAmbiguousPlainScalars(metadata);
		if (quotedMetadata) {
			try {
				const loaded = parseYamlRecord(quotedMetadata);
				return { frontmatter: normalizeKeys({ ...frontmatter, ...loaded }), body };
			} catch {}
		}

		const err = new FrontmatterError(
			error instanceof Error ? error : new Error(`YAML: ${error}`),
			loc ?? `Inline '${truncate(content, 64)}'`,
		);
		if (level === "warn" || level === "fatal") {
			logger.warn("Failed to parse YAML frontmatter", { err: err.toString() });
		}
		if (level === "fatal") {
			throw err;
		}

		for (const line of metadata.split("\n")) {
			const match = line.match(/^([\w-]+):\s*(.*)$/);
			if (match) {
				frontmatter[match[1]] = match[2].trim();
			}
		}

		return { frontmatter: normalizeKeys(frontmatter) as Record<string, unknown>, body };
	}
}
