import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { DOCUMENTATION_DECLARATIONS } from "../../src/scrapers/declarations/documentation";
import { createDocumentationHandler } from "../../src/scrapers/engine/documentation";
import type { LoadPageResult, RenderResult, SpecialHandler } from "../../src/scrapers/types";
import * as scraperTypes from "../../src/scrapers/types";

function asRender(result: unknown): RenderResult {
	expect(result).not.toBeNull();
	expect(typeof result).toBe("object");
	expect(result).toHaveProperty("content");
	return result as RenderResult;
}

const EXPECTED_SITES = [
	"cheatsh",
	"choosealicense",
	"mdn",
	"openlibrary",
	"readthedocs",
	"spdx",
	"tldr",
	"w3c",
	"wikidata",
	"wikipedia",
] as const;

interface SpyHandle {
	mockRestore: () => void;
}

describe("documentation declarations field fidelity", () => {
	let loadPageSpy: SpyHandle | null = null;

	afterEach(() => {
		if (loadPageSpy) {
			loadPageSpy.mockRestore();
			loadPageSpy = null;
		}
	});

	it("exports all expected documentation declarations at runtime", () => {
		const declaredSites = DOCUMENTATION_DECLARATIONS.map(d => d.site);
		for (const expected of EXPECTED_SITES) {
			expect(declaredSites).toContain(expected);
		}
		expect(declaredSites.length).toBe(EXPECTED_SITES.length);
	});

	describe("cheat.sh (cheatsh)", () => {
		const decl = DOCUMENTATION_DECLARATIONS.find(d => d.site === "cheatsh")!;
		const handler: SpecialHandler = createDocumentationHandler(decl);

		it("formats code topic in language-tagged fenced block", async () => {
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("python")) {
					return {
						ok: true,
						status: 200,
						content: "def add_item(lst, item):\n    lst.append(item)\n    return lst\n",
						contentType: "text/plain",
						finalUrl: url,
					} satisfies LoadPageResult;
				}
				return { ok: false, status: 404, content: "", contentType: "text/plain", finalUrl: url };
			});

			const res = asRender(await handler("https://cheat.sh/python/list", 10));
			expect(res.content).toContain("# cheat.sh/python/list");
			expect(res.content).toContain(
				"```python\ndef add_item(lst, item):\n    lst.append(item)\n    return lst\n```",
			);
			expect(res.method).toBe("cheat.sh");
		});

		it("formats command cheatsheet in plain fenced code block", async () => {
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				return {
					ok: true,
					status: 200,
					content: "tar -czvf archive.tar.gz /path/to/dir\ntar -xzvf archive.tar.gz\n",
					contentType: "text/plain",
					finalUrl: url,
				} satisfies LoadPageResult;
			});

			const res = asRender(await handler("https://cht.sh/tar", 10));
			expect(res.content).toContain("# cheat.sh/tar");
			expect(res.content).toContain("```\ntar -czvf archive.tar.gz /path/to/dir\ntar -xzvf archive.tar.gz\n```");
		});
	});

	describe("Choose a License (choosealicense)", () => {
		const decl = DOCUMENTATION_DECLARATIONS.find(d => d.site === "choosealicense")!;
		const handler: SpecialHandler = createDocumentationHandler(decl);

		it("renders license metadata, permissions, conditions, limitations, and license text", async () => {
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("_licenses/mit.txt")) {
					return {
						ok: true,
						status: 200,
						content: `---
title: MIT License
spdx-id: MIT
description: A short and simple permissive license with conditions.
permissions:
  - commercial-use
  - modifications
  - distribution
conditions:
  - include-copyright
limitations:
  - liability
  - warranty
---
Permission is hereby granted, free of charge, to any person obtaining a copy.
`,
						contentType: "text/plain",
						finalUrl: url,
					} satisfies LoadPageResult;
				}
				return { ok: false, status: 404, content: "", contentType: "text/plain", finalUrl: url };
			});

			const res = asRender(await handler("https://choosealicense.com/licenses/mit/", 10));
			expect(res.content).toContain("# MIT License");
			expect(res.content).toContain("A short and simple permissive license with conditions.");
			expect(res.content).toContain("**SPDX ID:** MIT");
			expect(res.content).toContain("**Source:** https://choosealicense.com/licenses/mit/");
			expect(res.content).toContain("## Permissions\n\n- Commercial use\n- Modifications\n- Distribution");
			expect(res.content).toContain("## Conditions\n\n- Include copyright");
			expect(res.content).toContain("## Limitations\n\n- Liability\n- Warranty");
			expect(res.content).toContain(
				"## License Text\n\nPermission is hereby granted, free of charge, to any person obtaining a copy.",
			);
		});
	});

	describe("MDN (mdn)", () => {
		const decl = DOCUMENTATION_DECLARATIONS.find(d => d.site === "mdn")!;
		const handler: SpecialHandler = createDocumentationHandler(decl);

		it("renders full MDN body structure including prose titles, code examples, definition lists, tables, browser compat, and specs", async () => {
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("/index.json")) {
					const mdnPayload = {
						doc: {
							title: "Array.prototype.map()",
							summary: "<p>The <code>map()</code> method creates a new array.</p>",
							mdn_url: "/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map",
							body: [
								{
									type: "prose",
									value: {
										id: "description",
										title: "Description",
										content: "<p>Calls a provided function once for each element in an array.</p>",
									},
								},
								{
									type: "prose",
									value: {
										id: "parameters",
										title: "Parameters",
										isH3: true,
										content: "<p>Function that is called for every element of arr.</p>",
									},
								},
								{
									type: "code_example",
									value: {
										title: "Mapping an array of numbers",
										code: "const numbers = [1, 4, 9];\nconst roots = numbers.map(x => Math.sqrt(x));",
										language: "js",
									},
								},
								{
									type: "definition_list",
									value: {
										items: [
											{
												term: "callbackFn",
												description: "<p>Function that is called for every element of arr.</p>",
											},
										],
									},
								},
								{
									type: "table",
									value: {
										rows: [
											["Feature", "Support"],
											["Array.prototype.map", "Full"],
										],
									},
								},
								{
									type: "browser_compatibility",
									value: {
										title: "Browser compatibility",
									},
								},
								{
									type: "specifications",
									value: {
										title: "Specifications",
									},
								},
							],
						},
					};
					return {
						ok: true,
						status: 200,
						content: JSON.stringify(mdnPayload),
						contentType: "application/json",
						finalUrl: url,
					} satisfies LoadPageResult;
				}
				return { ok: false, status: 404, content: "", contentType: "text/plain", finalUrl: url };
			});

			const res = asRender(
				await handler(
					"https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map",
					10,
				),
			);
			expect(res.content).toContain("# Array.prototype.map()");
			expect(res.content).toContain("The `map()` method creates a new array.");
			expect(res.content).toContain(
				"## Description\n\nCalls a provided function once for each element in an array.",
			);
			expect(res.content).toContain("### Parameters\n\nFunction that is called for every element of arr.");
			expect(res.content).toContain(
				"### Mapping an array of numbers\n\n```js\nconst numbers = [1, 4, 9];\nconst roots = numbers.map(x => Math.sqrt(x));\n```",
			);
			expect(res.content).toContain("**callbackFn**\n\nFunction that is called for every element of arr.");
			expect(res.content).toContain("| Feature | Support |\n\n| --- | --- |\n\n| Array.prototype.map | Full |");
			expect(res.content).toContain("## Browser compatibility\n\n(See browser compatibility data at MDN)");
			expect(res.content).toContain("## Specifications\n\n(See specifications at MDN)");
			expect(res.finalUrl).toBe("/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map");
		});
	});

	describe("Open Library (openlibrary)", () => {
		const decl = DOCUMENTATION_DECLARATIONS.find(d => d.site === "openlibrary")!;
		const handler: SpecialHandler = createDocumentationHandler(decl);

		it("renders work with resolved author names, cover, description, and subjects", async () => {
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("/works/OL45804W.json")) {
					return {
						ok: true,
						status: 200,
						content: JSON.stringify({
							title: "The Hitchhiker's Guide to the Galaxy",
							authors: [{ author: { key: "/authors/OL123A" } }],
							first_publish_date: "1979",
							covers: [12345],
							description: "Seconds before Earth is demolished...",
							subjects: ["Science fiction", "Humor"],
						}),
						contentType: "application/json",
						finalUrl: url,
					} satisfies LoadPageResult;
				}
				if (url.includes("/authors/OL123A.json")) {
					return {
						ok: true,
						status: 200,
						content: JSON.stringify({ name: "Douglas Adams" }),
						contentType: "application/json",
						finalUrl: url,
					} satisfies LoadPageResult;
				}
				return { ok: false, status: 404, content: "", contentType: "text/plain", finalUrl: url };
			});

			const res = asRender(await handler("https://openlibrary.org/works/OL45804W", 10));
			expect(res.content).toContain("# The Hitchhiker's Guide to the Galaxy");
			expect(res.content).toContain("**Authors:** Douglas Adams");
			expect(res.content).toContain("**First Published:** 1979");
			expect(res.content).toContain("**Cover:** https://covers.openlibrary.org/b/id/12345-L.jpg");
			expect(res.content).toContain("**Open Library:** https://openlibrary.org/works/OL45804W");
			expect(res.content).toContain("## Description\n\nSeconds before Earth is demolished...");
			expect(res.content).toContain("## Subjects\n\nScience fiction, Humor");
		});

		it("renders edition with publishers, pages, ISBN, work link, description, and subjects", async () => {
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("/books/OL7353617M.json")) {
					return {
						ok: true,
						status: 200,
						content: JSON.stringify({
							title: "The Hitchhiker's Guide to the Galaxy (Edition)",
							authors: [{ key: "OL123A" }],
							publishers: ["Pan Books"],
							publish_date: "1979",
							number_of_pages: 180,
							isbn_10: ["0330258648"],
							covers: [54321],
							works: [{ key: "/works/OL45804W" }],
							description: { value: "Pan paperback edition." },
							subjects: ["Fiction"],
						}),
						contentType: "application/json",
						finalUrl: url,
					} satisfies LoadPageResult;
				}
				if (url.includes("/authors/OL123A.json")) {
					return {
						ok: true,
						status: 200,
						content: JSON.stringify({ name: "Douglas Adams" }),
						contentType: "application/json",
						finalUrl: url,
					} satisfies LoadPageResult;
				}
				return { ok: false, status: 404, content: "", contentType: "text/plain", finalUrl: url };
			});

			const res = asRender(await handler("https://openlibrary.org/books/OL7353617M", 10));
			expect(res.content).toContain("# The Hitchhiker's Guide to the Galaxy (Edition)");
			expect(res.content).toContain("**Authors:** Douglas Adams");
			expect(res.content).toContain("**Publishers:** Pan Books");
			expect(res.content).toContain("**Published:** 1979");
			expect(res.content).toContain("**Pages:** 180");
			expect(res.content).toContain("**ISBN:** 0330258648");
			expect(res.content).toContain("**Work:** https://openlibrary.org/works/OL45804W");
			expect(res.content).toContain("## Description\n\nPan paperback edition.");
			expect(res.content).toContain("## Subjects\n\nFiction");
		});

		it("renders book lookup by ISBN", async () => {
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("bibkeys=ISBN:0330258648")) {
					return {
						ok: true,
						status: 200,
						content: JSON.stringify({
							"ISBN:0330258648": {
								title: "The Hitchhiker's Guide (ISBN Record)",
								authors: [{ name: "Douglas Adams" }],
								publishers: [{ name: "Pan Books" }],
								publish_date: "1979",
								number_of_pages: 180,
								cover: { large: "https://covers.openlibrary.org/b/id/54321-L.jpg" },
								url: "https://openlibrary.org/books/OL7353617M",
								subjects: [{ name: "Sci-Fi" }],
							},
						}),
						contentType: "application/json",
						finalUrl: url,
					} satisfies LoadPageResult;
				}
				return { ok: false, status: 404, content: "", contentType: "text/plain", finalUrl: url };
			});

			const res = asRender(await handler("https://openlibrary.org/isbn/0330258648", 10));
			expect(res.content).toContain("# The Hitchhiker's Guide (ISBN Record)");
			expect(res.content).toContain("**Authors:** Douglas Adams");
			expect(res.content).toContain("**Publishers:** Pan Books");
			expect(res.content).toContain("**ISBN:** 0330258648");
			expect(res.content).toContain("## Subjects\n\nSci-Fi");
		});
	});

	describe("Read the Docs (readthedocs)", () => {
		const decl = DOCUMENTATION_DECLARATIONS.find(d => d.site === "readthedocs")!;
		const handler: SpecialHandler = createDocumentationHandler(decl);

		it("strips navigation/sidebar/footer elements and converts main content to markdown", async () => {
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				return {
					ok: true,
					status: 200,
					content: `<!DOCTYPE html>
<html>
<body>
<div class="document">
  <div class="rst-content">
    <div class="headerlink">¶</div>
    <div class="viewcode-link">[source]</div>
    <nav class="wy-nav-side">Nav to strip</nav>
    <div class="sidebar">Sidebar to strip</div>
    <div class="toctree-wrapper">TOC to strip</div>
    <h1>Requests: HTTP for Humans</h1>
    <p>Requests is an elegant and simple HTTP library for Python.</p>
    <div class="related">Related to strip</div>
    <footer>Footer to strip</footer>
  </div>
</div>
</body>
</html>`,
					contentType: "text/html",
					finalUrl: url,
				} satisfies LoadPageResult;
			});

			const res = asRender(await handler("https://requests.readthedocs.io/en/latest/", 10));
			expect(res.content).toContain("Requests: HTTP for Humans");
			expect(res.content).toContain("Requests is an elegant and simple HTTP library for Python.");
			expect(res.content).not.toContain("Nav to strip");
			expect(res.content).not.toContain("Sidebar to strip");
			expect(res.content).not.toContain("TOC to strip");
			expect(res.content).not.toContain("Related to strip");
			expect(res.content).not.toContain("Footer to strip");
			expect(res.content).not.toContain("[source]");
		});

		it("fetches raw source from edit links when present", async () => {
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("requests.readthedocs.io")) {
					return {
						ok: true,
						status: 200,
						content: `<!DOCTYPE html>
<html>
<body>
<div class="document">
  <a href="https://github.com/psf/requests/blob/main/docs/index.rst">Edit on GitHub</a>
  <h1>Rendered HTML heading</h1>
</div>
</body>
</html>`,
						contentType: "text/html",
						finalUrl: url,
					} satisfies LoadPageResult;
				}
				if (url.includes("github.com/psf/requests/raw/main/docs/index.rst")) {
					return {
						ok: true,
						status: 200,
						content: "Requests: HTTP for Humans\n========================\n\nRaw reStructuredText from GitHub.",
						contentType: "text/plain",
						finalUrl: url,
					} satisfies LoadPageResult;
				}
				return { ok: false, status: 404, content: "", contentType: "text/plain", finalUrl: url };
			});

			const res = asRender(await handler("https://requests.readthedocs.io/en/latest/", 10));
			expect(res.content).toBe(
				"Requests: HTTP for Humans\n========================\n\nRaw reStructuredText from GitHub.",
			);
			expect(res.notes).toContain("Fetched raw source from https://github.com/psf/requests/raw/main/docs/index.rst");
		});
	});

	describe("SPDX (spdx)", () => {
		const decl = DOCUMENTATION_DECLARATIONS.find(d => d.site === "spdx")!;
		const handler: SpecialHandler = createDocumentationHandler(decl);

		it("renders license with ID, OSI/FSF flags, description, cross-references, and fenced license text", async () => {
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("spdx.org/licenses/MIT.json")) {
					return {
						ok: true,
						status: 200,
						content: JSON.stringify({
							licenseId: "MIT",
							name: "MIT License",
							isOsiApproved: true,
							isFsfLibre: true,
							licenseComments: "Standard permissive open source license.",
							seeAlso: ["https://opensource.org/licenses/MIT"],
							crossRef: [{ url: "https://mit-license.org", order: 0 }],
							licenseText: "Copyright (c) <year> <copyright holders>\n\nPermission is hereby granted...",
						}),
						contentType: "application/json",
						finalUrl: url,
					} satisfies LoadPageResult;
				}
				return { ok: false, status: 404, content: "", contentType: "text/plain", finalUrl: url };
			});

			const res = asRender(await handler("https://spdx.org/licenses/MIT.html", 10));
			expect(res.content).toContain("# MIT License");
			expect(res.content).toContain("**License ID:** `MIT`");
			expect(res.content).toContain("**OSI Approved:** Yes");
			expect(res.content).toContain("**FSF Libre:** Yes");
			expect(res.content).toContain("## Description\n\nStandard permissive open source license.");
			expect(res.content).toContain(
				"## Cross References\n\n- https://mit-license.org\n- https://opensource.org/licenses/MIT",
			);
			expect(res.content).toContain(
				"## License Text\n\n```\nCopyright (c) <year> <copyright holders>\n\nPermission is hereby granted...\n```",
			);
			expect(res.method).toBe("spdx-api");
		});
	});

	describe("tldr-pages (tldr)", () => {
		const decl = DOCUMENTATION_DECLARATIONS.find(d => d.site === "tldr")!;
		const handler: SpecialHandler = createDocumentationHandler(decl);

		it("fetches platform markdown in priority order and records finalUrl and platform note", async () => {
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("/pages/common/tar.md")) {
					return {
						ok: true,
						status: 200,
						content:
							"# tar\n\n> Archiving utility.\n\n- Create an archive:\n  `tar -cf target.tar file1 file2`\n",
						contentType: "text/plain",
						finalUrl: url,
					} satisfies LoadPageResult;
				}
				return { ok: false, status: 404, content: "", contentType: "text/plain", finalUrl: url };
			});

			const res = asRender(await handler("https://tldr.ostera.io/tar", 10));
			expect(res.content).toContain("# tar\n\n> Archiving utility.");
			expect(res.finalUrl).toBe("https://raw.githubusercontent.com/tldr-pages/tldr/main/pages/common/tar.md");
			expect(res.notes).toContain("Fetched from tldr-pages (common)");
			expect(res.method).toBe("tldr");
		});
	});

	describe("W3C Specifications (w3c)", () => {
		const decl = DOCUMENTATION_DECLARATIONS.find(d => d.site === "w3c")!;
		const handler: SpecialHandler = createDocumentationHandler(decl);

		it("extracts shortname from versioned TR path, fetches spec and latest version, and renders metadata and abstract", async () => {
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url === "https://api.w3.org/specifications/css-color-4") {
					return {
						ok: true,
						status: 200,
						content: JSON.stringify({
							title: "CSS Color Module Level 4",
							shortname: "css-color-4",
							description: "<p>CSS Color Module Level 4 defines CSS color values and properties.</p>",
							_links: {
								"version-history": {
									href: "https://www.w3.org/standards/history/css-color-4",
								},
							},
						}),
						contentType: "application/json",
						finalUrl: url,
					} satisfies LoadPageResult;
				}
				if (url === "https://api.w3.org/specifications/css-color-4/versions/latest") {
					return {
						ok: true,
						status: 200,
						content: JSON.stringify({
							status: "Candidate Recommendation",
							shortlink: "https://www.w3.org/TR/css-color-4/",
							_links: {
								editors: {
									href: "https://api.w3.org/specifications/css-color-4/versions/20220105/editors",
								},
							},
						}),
						contentType: "application/json",
						finalUrl: url,
					} satisfies LoadPageResult;
				}
				if (url === "https://api.w3.org/specifications/css-color-4/versions/20220105/editors") {
					return {
						ok: true,
						status: 200,
						content: JSON.stringify({
							_links: {
								editors: [{ title: "Tab Atkins Jr." }, { title: "Chris Lilley" }],
							},
						}),
						contentType: "application/json",
						finalUrl: url,
					} satisfies LoadPageResult;
				}
				return { ok: false, status: 404, content: "", contentType: "text/plain", finalUrl: url };
			});

			// Versioned path testing extractShortname regex
			const res = asRender(await handler("https://www.w3.org/TR/2020/WD-css-color-4-20201112/", 10));
			expect(res.content).toContain("# CSS Color Module Level 4");
			expect(res.content).toContain(
				"## Abstract\n\nCSS Color Module Level 4 defines CSS color values and properties.",
			);
			expect(res.content).toContain("## Metadata");
			expect(res.content).toContain("**Shortname:** css-color-4");
			expect(res.content).toContain("**Status:** CR (Candidate Recommendation)");
			expect(res.content).toContain("**Editors:** Tab Atkins Jr., Chris Lilley");
			expect(res.content).toContain("**Latest Version:** https://www.w3.org/TR/css-color-4/");
			expect(res.content).toContain("**History:** https://www.w3.org/standards/history/css-color-4");
			expect(res.method).toBe("w3c-api");
		});
	});

	describe("Wikidata (wikidata)", () => {
		const decl = DOCUMENTATION_DECLARATIONS.find(d => d.site === "wikidata")!;
		const handler: SpecialHandler = createDocumentationHandler(decl);

		it("renders label, description, aliases, article counts, property claims with resolved entity labels and formatted dates/coordinates, and Wikipedia links", async () => {
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("Special:EntityData/Q42.json")) {
					return {
						ok: true,
						status: 200,
						content: JSON.stringify({
							entities: {
								Q42: {
									id: "Q42",
									labels: { en: { language: "en", value: "Douglas Adams" } },
									descriptions: { en: { language: "en", value: "English author and humorist" } },
									aliases: { en: [{ language: "en", value: "Douglas Noel Adams" }] },
									sitelinks: {
										enwiki: { site: "enwiki", title: "Douglas Adams" },
										frwiki: { site: "frwiki", title: "Douglas Adams" },
									},
									claims: {
										P31: [
											{
												rank: "normal",
												mainsnak: {
													snaktype: "value",
													property: "P31",
													datavalue: {
														type: "wikibase-entityid",
														value: { id: "Q5" },
													},
												},
											},
										],
										P569: [
											{
												rank: "normal",
												mainsnak: {
													snaktype: "value",
													property: "P569",
													datavalue: {
														type: "time",
														value: { time: "+1952-03-11T00:00:00Z", precision: 11 },
													},
												},
											},
										],
										P625: [
											{
												rank: "normal",
												mainsnak: {
													snaktype: "value",
													property: "P625",
													datavalue: {
														type: "globecoordinate",
														value: { latitude: 52.2053, longitude: 0.1218 },
													},
												},
											},
										],
										P1128: [
											{
												rank: "normal",
												mainsnak: {
													snaktype: "value",
													property: "P1128",
													datavalue: {
														type: "quantity",
														value: { amount: "+42", unit: "1" },
													},
												},
											},
										],
									},
								},
							},
						}),
						contentType: "application/json",
						finalUrl: url,
					} satisfies LoadPageResult;
				}
				if (url.includes("action=wbgetentities") && url.includes("Q5")) {
					return {
						ok: true,
						status: 200,
						content: JSON.stringify({
							entities: {
								Q5: { labels: { en: { value: "human" } } },
							},
						}),
						contentType: "application/json",
						finalUrl: url,
					} satisfies LoadPageResult;
				}
				return { ok: false, status: 404, content: "", contentType: "text/plain", finalUrl: url };
			});

			const res = asRender(await handler("https://www.wikidata.org/wiki/Q42", 10));
			expect(res.content).toContain("# Douglas Adams (Q42)");
			expect(res.content).toContain("*English author and humorist*");
			expect(res.content).toContain("**Also known as:** Douglas Noel Adams");
			expect(res.content).toContain("**Wikipedia articles:** 2 languages");
			expect(res.content).toContain("## Properties");
			expect(res.content).toContain("- **Instance of:** human");
			expect(res.content).toContain("- **Born:** 11/03/1952");
			expect(res.content).toContain("- **Coordinates:** 52.2053, 0.1218");
			expect(res.content).toContain("- **Employees:** 42");
			expect(res.content).toContain(
				"## Wikipedia Links\n\n[EN](https://en.wikipedia.org/wiki/Douglas%20Adams) · [FR](https://fr.wikipedia.org/wiki/Douglas%20Adams)",
			);
			expect(res.method).toBe("wikidata");
		});
	});

	describe("Wikipedia (wikipedia)", () => {
		const decl = DOCUMENTATION_DECLARATIONS.find(d => d.site === "wikipedia")!;
		const handler: SpecialHandler = createDocumentationHandler(decl);

		it("renders summary, description, and content sections while stripping reference sections", async () => {
			loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
				if (url.includes("/page/summary/")) {
					return {
						ok: true,
						status: 200,
						content: JSON.stringify({
							title: "Douglas Adams",
							description: "English author and humorist",
							extract: "Douglas Noel Adams was an English author, screenwriter, essayist, and humorist.",
						}),
						contentType: "application/json",
						finalUrl: url,
					} satisfies LoadPageResult;
				}
				if (url.includes("/page/mobile-html/")) {
					return {
						ok: true,
						status: 200,
						content: `<!DOCTYPE html>
<html>
<body>
<section>
  <h2>Early life</h2>
  <p>Douglas Noel Adams was born in Cambridge on 11 March 1952 to Janet and Christopher Douglas Adams.</p>
</section>
<section>
  <h2>References</h2>
  <p>Reference content to strip completely.</p>
</section>
<section>
  <h2>External links</h2>
  <p>Links content to strip completely.</p>
</section>
</body>
</html>`,
						contentType: "text/html",
						finalUrl: url,
					} satisfies LoadPageResult;
				}
				return { ok: false, status: 404, content: "", contentType: "text/plain", finalUrl: url };
			});

			const res = asRender(await handler("https://en.wikipedia.org/wiki/Douglas_Adams", 10));
			expect(res.content).toContain("# Douglas Adams");
			expect(res.content).toContain("*English author and humorist*");
			expect(res.content).toContain(
				"Douglas Noel Adams was an English author, screenwriter, essayist, and humorist.",
			);
			expect(res.content).toContain("## Early life");
			expect(res.content).toContain(
				"Douglas Noel Adams was born in Cambridge on 11 March 1952 to Janet and Christopher Douglas Adams.",
			);
			expect(res.content).not.toContain("## References");
			expect(res.content).not.toContain("Reference content to strip completely.");
			expect(res.content).not.toContain("## External links");
			expect(res.content).not.toContain("Links content to strip completely.");
			expect(res.method).toBe("wikipedia");
		});
	});
});
