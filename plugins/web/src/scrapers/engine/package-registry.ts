import type { RenderResult, ScraperDegrade, SpecialHandler } from "../types";
import type { DeclarativeContext } from "./declarative";
import { createDeclarativeHandler } from "./declarative";

export interface PackageRegistryMatch {
	name: string;
	version?: string;
	parsedUrl: URL;
}

export interface PackageRegistryContext extends DeclarativeContext {}

export interface PackageRegistryDeclaration {
	site: string;
	method?: string;
	hosts: string[];
	canonicalUrls: string[];
	pathPattern?: RegExp;
	match?: (parsedUrl: URL) => PackageRegistryMatch | null;
	customFetch: (
		match: PackageRegistryMatch,
		ctx: PackageRegistryContext,
	) => Promise<string | RenderResult | ScraperDegrade | null>;
	notes?: string[];
}

export function createPackageRegistryHandler(decl: PackageRegistryDeclaration, handlerName?: string): SpecialHandler {
	return createDeclarativeHandler<PackageRegistryMatch>(
		{
			site: decl.site,
			method: decl.method ?? decl.site,
			hosts: decl.hosts.map(h => h.toLowerCase()),
			canonicalUrls: decl.canonicalUrls,
			match: (parsed: URL) => {
				let match: PackageRegistryMatch | null = null;
				if (decl.match) {
					match = decl.match(parsed);
				} else if (decl.pathPattern) {
					const m = parsed.pathname.match(decl.pathPattern);
					if (m) {
						match = {
							name: decodeURIComponent(m[1]),
							version: m[2] ? decodeURIComponent(m[2]) : undefined,
							parsedUrl: parsed,
						};
					}
				}
				if (!match || !match.name) return null;
				return match;
			},
			fetch: (match, ctx) => decl.customFetch(match, ctx),
			notes: decl.notes,
		},
		handlerName,
	);
}
