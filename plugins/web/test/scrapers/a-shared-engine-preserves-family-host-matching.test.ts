import { describe, expect, it } from "bun:test";
import { type AcademicPaperDeclaration, createAcademicPaperHandler } from "../../src/scrapers/engine/academic-paper";
import * as business from "../../src/scrapers/engine/business";
import type { DeclarativeSite } from "../../src/scrapers/engine/declarative";
import * as discussion from "../../src/scrapers/engine/discussion";
import * as documentation from "../../src/scrapers/engine/documentation";
import * as media from "../../src/scrapers/engine/media";
import {
	createPackageRegistryHandler,
	type PackageRegistryDeclaration,
} from "../../src/scrapers/engine/package-registry";
import * as security from "../../src/scrapers/engine/security-advisory";
import type { SpecialHandler } from "../../src/scrapers/types";

/**
 * Shared dispatch must preserve each family's exact versus wildcard host policy,
 * result passthrough, and cancellation. Upstream payload fidelity is tested separately.
 */
type Declaration = DeclarativeSite<{ id: string; parsedUrl: URL }>;
const factories: Record<string, (declaration: Declaration, name?: string) => SpecialHandler> = {
	...business,
	...discussion,
	...documentation,
	...media,
	...security,
};
const wildcardPolicy: Record<string, boolean> = {
	createBusinessHandler: false,
	createDiscussionHandler: true,
	createDocumentationHandler: true,
	createMediaHandler: false,
	createSecurityAdvisoryHandler: false,
};
function declaration(hosts: string[]): Declaration {
	return {
		site: "sample",
		method: "sample-api",
		hosts,
		canonicalUrls: ["https://example.test/item"],
		match: parsedUrl => ({ id: "sample", parsedUrl }),
		fetch: async () => "custom response",
	};
}

describe("shared declarative family dispatch", () => {
	it("retains callback receivers and request-local notes across adapted families", async () => {
		const registry: PackageRegistryDeclaration & { marker: string } = {
			site: "registry",
			marker: "package",
			hosts: ["EXAMPLE.test"],
			canonicalUrls: [],
			match(parsedUrl) {
				return { name: this.marker, parsedUrl };
			},
			async customFetch(match) {
				return `${this.marker}:${match.name}`;
			},
		};
		const paper: AcademicPaperDeclaration & { marker: string } = {
			site: "academic",
			marker: "paper",
			hosts: ["EXAMPLE.test"],
			canonicalUrls: [],
			match(parsedUrl) {
				return { id: this.marker, parsedUrl };
			},
			method(match) {
				return `${this.marker}-${match.id}`;
			},
			async fetch(match, ctx) {
				ctx.notes.push(this.marker);
				return { title: `${this.marker}:${match.id}` };
			},
		};
		const registryHandler = createPackageRegistryHandler(registry);
		const paperHandler = createAcademicPaperHandler(paper);
		for (let request = 0; request < 2; request++) {
			expect(await registryHandler("https://example.test/item", 1)).toMatchObject({
				content: "package:package",
				method: "registry",
			});
			expect(await paperHandler("https://example.test/item", 1)).toMatchObject({
				content: "paper:paper",
				method: "paper-paper",
				notes: ["paper"],
			});
		}
	});

	it("requires a host-policy decision for every exported factory", () => {
		expect(Object.keys(factories).sort()).toEqual(Object.keys(wildcardPolicy).sort());
	});
	for (const [name, factory] of Object.entries(factories)) {
		it(`${name} preserves exact, wildcard, and case-sensitive declaration matching`, async () => {
			const exact = factory(declaration(["example.test"]));
			const wildcard = factory(declaration(["*.example.test"]));
			expect(await exact("https://EXAMPLE.test/item", 1)).toMatchObject({ content: "custom response" });
			for (const url of ["not a URL", "https://sub.example.test/item", "https://example.test.invalid/item"]) {
				expect(await exact(url, 1)).toBeNull();
			}
			for (const url of ["https://example.test/item", "https://sub.example.test/item"]) {
				const result = await wildcard(url, 1);
				if (wildcardPolicy[name]) expect(result).toMatchObject({ content: "custom response" });
				else expect(result).toBeNull();
			}
			expect(await wildcard("https://notexample.test/item", 1)).toBeNull();
			expect(await factory(declaration(["EXAMPLE.test"]))("https://example.test/item", 1)).toBeNull();
		});
		it(`${name} returns finished and degraded responses without rendering metadata`, async () => {
			const decl = declaration(["example.test"]);
			const finished = {
				url: "https://example.test/item",
				finalUrl: "https://example.test/final",
				contentType: "text/plain",
				method: "custom",
				content: "finished",
				fetchedAt: "2026-01-01T00:00:00Z",
				truncated: true,
				notes: ["custom"],
			};
			decl.fetch = async () => finished;
			expect(await factory(decl)(finished.url, 1)).toEqual(finished);
			const degraded = { scraperDegrade: true as const, note: "upstream failed" };
			decl.fetch = async () => degraded;
			expect(await factory(decl)(finished.url, 1)).toEqual(degraded);
			decl.fetch = async () => null;
			expect(await factory(decl)(finished.url, 1)).toBeNull();
		});
		it(`${name} distinguishes cancellation from an ordinary upstream failure`, async () => {
			const decl = declaration(["example.test"]);
			decl.fetch = async () => {
				throw new Error("upstream failed");
			};
			expect(await factory(decl)("https://example.test/item", 1)).toMatchObject({ scraperDegrade: true });
			decl.fetch = async () => {
				throw new DOMException("cancelled", "AbortError");
			};
			await expect(factory(decl)("https://example.test/item", 1)).rejects.toMatchObject({ name: "AbortError" });
		});
	}
});
