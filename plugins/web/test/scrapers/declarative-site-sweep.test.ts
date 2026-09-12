import { describe, expect, it } from "bun:test";
import { SITE_DECLARATION_ENTRIES, specialHandlers } from "@veyyon/web/scrapers";
import { tryParseUrl } from "../../src/scrapers/types";

describe("declarative site registry offline sweep", () => {
	it("registry is non-empty and every site declares canonical test URLs", () => {
		expect(SITE_DECLARATION_ENTRIES.length).toBeGreaterThanOrEqual(60);
		for (const entry of SITE_DECLARATION_ENTRIES) {
			expect(entry.site).toBeDefined();
			expect(typeof entry.site).toBe("string");
			expect(entry.declaration.canonicalUrls).toBeDefined();
			expect(Array.isArray(entry.declaration.canonicalUrls)).toBe(true);
			expect(entry.declaration.canonicalUrls.length).toBeGreaterThan(0);
		}
		for (const entry of SITE_DECLARATION_ENTRIES) {
			const decl = entry.declaration;
			if (decl.apiUrl && !decl.fetch && !decl.customFetch) {
				expect(decl.mapping).toBeDefined();
				expect(Object.keys(decl.mapping || {}).length).toBeGreaterThan(0);
			}
		}
	});

	it("every declared site matches all its own canonical URLs and extracts identifiers", () => {
		for (const entry of SITE_DECLARATION_ENTRIES) {
			const decl = entry.declaration;
			for (const url of decl.canonicalUrls) {
				const parsed = tryParseUrl(url);
				expect(parsed).not.toBeNull();

				const hostSet = new Set(decl.hosts.map((h: string) => h.toLowerCase()));
				const hostname = parsed!.hostname.toLowerCase();
				const matchesHost =
					hostSet.has(hostname) ||
					Array.from(hostSet).some((h: string) => {
						if (h.startsWith("*.")) {
							return hostname.endsWith(h.slice(1)) || hostname === h.slice(2);
						}
						return false;
					});

				expect(matchesHost).toBe(true);

				expect(Boolean(decl.match || decl.pathPattern)).toBe(true);
				const matchResult = decl.match ? decl.match(parsed!) : parsed!.pathname.match(decl.pathPattern!);
				expect(matchResult).not.toBeNull();
			}
		}
	});

	it("every site handler rejects foreign and sibling URLs synchronously without network", async () => {
		const foreignUrls = [
			"https://example.com/some/random/path",
			"https://google.com/search?q=test",
			"https://unrelated-domain.org/package/123",
		];

		const handlers = new Map(SITE_DECLARATION_ENTRIES.map(e => [e.site, e.createHandler()]));

		for (const entry of SITE_DECLARATION_ENTRIES) {
			const handler = handlers.get(entry.site)!;

			// Foreign URLs must return null
			for (const foreignUrl of foreignUrls) {
				const res = await handler(foreignUrl, 1);
				expect(res).toBeNull();
			}

			// Sibling URLs from all other sites must return null
			for (const sibling of SITE_DECLARATION_ENTRIES) {
				if (sibling.site === entry.site) continue;
				for (const siblingUrl of sibling.declaration.canonicalUrls) {
					// Unless they intentionally share a host (e.g. w3c and w3c specs)
					const parsed = tryParseUrl(siblingUrl);
					const isSharedHost = entry.declaration.hosts.some(
						(h: string) => h.toLowerCase() === parsed?.hostname.toLowerCase(),
					);
					if (!isSharedHost) {
						const res = await handler(siblingUrl, 1);
						expect(res).toBeNull();
					}
				}
			}
		}
	});

	it("every handler in specialHandlers has a corresponding callable function", () => {
		expect(specialHandlers.length).toBeGreaterThanOrEqual(SITE_DECLARATION_ENTRIES.length);
		for (const handler of specialHandlers) {
			expect(typeof handler).toBe("function");
			expect(handler.name.startsWith("handle")).toBe(true);
		}
	});
});
