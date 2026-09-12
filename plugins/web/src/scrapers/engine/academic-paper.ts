import type { RenderResult, ScraperDegrade, ScrapeServices, SpecialHandler } from "../types";
import { buildResult } from "../types";
import { fetchBinary } from "../utils";
import { createDeclarativeHandler, type DeclarativeContext } from "./declarative";

export interface AcademicMatch {
	id: string;
	isPdf?: boolean;
	server?: string;
	doi?: string;
	pmid?: string;
	rfcNumber?: string;
	parsedUrl: URL;
}

export interface AcademicPaperMeta {
	title: string;
	authors?: string[];
	abstract?: string;
	doi?: string;
	published?: string;
	journal?: string;
	citations?: number | string;
	customMarkdown?: string;
}

export interface AcademicPaperContext extends DeclarativeContext {
	notes: string[];
}

export interface AcademicPaperDeclaration {
	site: string;
	method: string | ((match: AcademicMatch) => string);
	hosts: string[];
	canonicalUrls: string[];
	match: (parsedUrl: URL) => AcademicMatch | null;
	fetch: (
		match: AcademicMatch,
		ctx: AcademicPaperContext,
	) => Promise<AcademicPaperMeta | RenderResult | ScraperDegrade | string | null>;
	notes?: string[] | ((match: AcademicMatch, meta?: AcademicPaperMeta) => string[]);
}

export async function appendConvertedPdfSection(
	pdfUrl: string,
	ctx: { timeout: number; signal?: AbortSignal; services?: ScrapeServices; notes: string[] },
	minContentLength = 500,
): Promise<string> {
	ctx.notes.push("Fetching PDF for full content...");
	const pdfRes = await fetchBinary(pdfUrl, ctx.timeout, ctx.signal);
	if (!ctx.services) {
		ctx.notes.push("PDF not converted: no document converter was supplied");
		return "";
	}
	if (pdfRes.ok) {
		const converted = await ctx.services.convertDocument(pdfRes.buffer, ".pdf", ctx.timeout, ctx.signal);
		if (converted.ok && converted.content.length > minContentLength) {
			ctx.notes.push("PDF converted via markit");
			return `---\n\n## Full Paper\n\n${converted.content}\n`;
		}
	}
	return "";
}

export function createAcademicPaperHandler(decl: AcademicPaperDeclaration, handlerName?: string): SpecialHandler {
	return createDeclarativeHandler<AcademicMatch>(
		{
			site: decl.site,
			method: decl.site,
			hosts: decl.hosts.map(h => h.toLowerCase()),
			canonicalUrls: decl.canonicalUrls,
			match: parsed => decl.match(parsed),
			fetch: async (match, baseContext) => {
				const ctx: AcademicPaperContext = Object.assign(baseContext, { notes: [] });
				const result = await decl.fetch(match, ctx);
				if (!result) return null;
				if (typeof result === "object" && ("content" in result || "scraperDegrade" in result)) {
					return result;
				}

				const isCustom = typeof result === "string" || Boolean(result.customMarkdown);
				const content = typeof result === "string" ? result : (result.customMarkdown ?? result.title);
				const method = typeof decl.method === "function" ? decl.method(match) : decl.method;
				const noteList = isCustom
					? typeof decl.notes === "function"
						? decl.notes(match, typeof result === "string" ? undefined : result)
						: (decl.notes ?? [`Fetched via ${method} API`])
					: [`Fetched via ${method} API`];

				return buildResult(content, {
					url: ctx.url,
					method,
					fetchedAt: ctx.fetchedAt,
					notes: ctx.notes.length > 0 ? ctx.notes : noteList,
				});
			},
		},
		handlerName,
	);
}
