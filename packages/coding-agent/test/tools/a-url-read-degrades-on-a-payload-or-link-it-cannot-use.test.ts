/**
 * WHY: a URL read failed outright on two inputs a page controls. An image response whose bytes did
 * not decode threw "Image normalization failed" out of the read, because the image renderer checked
 * the resized dimensions for a failed decode and `resizeImage` rejects instead of returning one. An
 * HTML page whose markdown or feed `<link rel="alternate">` carried an href that does not resolve
 * against the page threw `Invalid URL` out of the read before any reader ran.
 *
 * The class closed: a payload or a link the page hands over that the reader cannot use degrades the
 * read to a notice or to the next renderer, and never fails it. The sweep covers every inline image
 * type, by content type and by extension, every structured binary kind (notebook, SQLite, zip, tar,
 * gzip) and both alternate-link kinds. It also pins that a document that does not convert is
 * downloaded once: the binary payload renderers read the bytes the converter already fetched.
 *
 * Gap: the content-type tables in fetch.ts are module-private, so the sweep lists their members by
 * hand; a new payload kind added to those tables is not covered until it is added here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@veyyon/ai";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import * as scrapeServices from "@veyyon/coding-agent/tools/web/scrape-services";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import * as scrapers from "@veyyon/web/scrapers/types";
import * as scraperUtils from "@veyyon/web/scrapers/utils";

const GARBAGE = new Uint8Array([0x13, 0x37, 0x00, 0xff, 0x42, 0x42, 0x00, 0x01, 0x02, 0x03]);

const ARTICLE = `<html><head><title>Article</title>{{head}}</head><body><article><h1>Heading</h1>${"<p>This paragraph carries enough prose to count as real content for every reader backend that reads it.</p>".repeat(6)}</article></body></html>`;

function makeSession(testDir: string): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	let nextArtifactId = 0;
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		allocateOutputArtifact: async toolType => {
			const id = String(nextArtifactId++);
			return { id, path: path.join(artifactsDir, `${id}.${toolType}.log`) };
		},
		settings: Settings.isolated({ "fetch.enabled": true }),
	};
}

function textOutput(result: { content: Array<TextContent | ImageContent> }): string {
	return result.content
		.filter((content): content is TextContent => content.type === "text")
		.map(content => content.text)
		.join("\n");
}

/**
 * Every page request answers `pages[url]`, or a 404; every binary refetch answers `bytes` and counts
 * one download.
 */
function stubSite(
	pages: Record<string, { contentType: string; content: string }>,
	bytes: Uint8Array,
): { readonly downloads: number } {
	vi.spyOn(scrapers, "loadPage").mockImplementation(async (url, options) => {
		const page = pages[url];
		if (!page) return { ok: false, status: 404, content: "", contentType: "text/plain", finalUrl: url };
		if (options?.skipBodyForContentType?.(page.contentType)) {
			return { ok: true, status: 200, content: "", contentType: page.contentType, finalUrl: url, bodySkipped: true };
		}
		return { ok: true, status: 200, finalUrl: url, ...page };
	});
	const site = { downloads: 0 };
	vi.spyOn(scraperUtils, "fetchBinary").mockImplementation(async () => {
		site.downloads += 1;
		return { ok: true, buffer: bytes };
	});
	return site;
}

describe("a URL read degrades on a payload or link it cannot use", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `url-read-degrades-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(testDir);
	});

	async function read(url: string) {
		return new ReadTool(makeSession(testDir)).execute("read-url", { path: url });
	}

	const images: Array<{ label: string; contentType: string; extension: string; mimeType: string }> = [
		{ label: "png by type", contentType: "image/png", extension: "", mimeType: "image/png" },
		{ label: "jpeg by type", contentType: "image/jpeg", extension: "", mimeType: "image/jpeg" },
		{ label: "gif by type", contentType: "image/gif", extension: "", mimeType: "image/gif" },
		{ label: "webp by type", contentType: "image/webp", extension: "", mimeType: "image/webp" },
		{ label: "png by extension", contentType: "application/octet-stream", extension: ".png", mimeType: "image/png" },
		{
			label: "jpeg by extension",
			contentType: "application/octet-stream",
			extension: ".jpg",
			mimeType: "image/jpeg",
		},
		{ label: "gif by extension", contentType: "application/octet-stream", extension: ".gif", mimeType: "image/gif" },
		{
			label: "webp by extension",
			contentType: "application/octet-stream",
			extension: ".webp",
			mimeType: "image/webp",
		},
	];
	for (const image of images) {
		it(`answers an undecodable ${image.label} image with its label, not a failure`, async () => {
			const url = `https://example.com/picture-${Snowflake.next()}${image.extension}`;
			stubSite({ [url]: { contentType: image.contentType, content: "\u0000garbage" } }, GARBAGE);

			const result = await read(url);

			expect(result.details?.method).toBe("image-invalid");
			expect(result.details?.contentType).toBe(image.mimeType);
			expect(result.details?.notes).toEqual([
				"Fetched image binary",
				`Fetched payload could not be decoded as ${image.mimeType}; returning text metadata only`,
			]);
			expect(textOutput(result)).toEndWith(
				`Fetched payload was labeled ${image.mimeType}, but bytes were not a valid image.`,
			);
			expect(result.content.some(block => block.type === "image")).toBe(false);
		});
	}

	it("answers an undecodable image whose first response was a text page with that page", async () => {
		const url = `https://example.com/picture-${Snowflake.next()}.png`;
		const gateway = "<html><body>502 upstream unavailable</body></html>";
		stubSite({ [url]: { contentType: "application/octet-stream", content: gateway } }, GARBAGE);

		const result = await read(url);

		expect(result.details?.method).toBe("image-invalid");
		expect(textOutput(result)).toEndWith(gateway);
	});

	const payloads: Array<{ label: string; contentType: string; format: string }> = [
		{ label: "notebook", contentType: "application/x-ipynb+json", format: "Notebook" },
		{ label: "SQLite database", contentType: "application/vnd.sqlite3", format: "SQLite" },
		{ label: "zip archive", contentType: "application/zip", format: "Archive" },
		{ label: "tar archive", contentType: "application/x-tar", format: "Archive" },
		{ label: "gzip archive", contentType: "application/gzip", format: "Archive" },
	];
	for (const payload of payloads) {
		it(`answers a corrupt ${payload.label} with a binary notice naming the failed render`, async () => {
			const url = `https://example.com/payload-${Snowflake.next()}`;
			stubSite({ [url]: { contentType: payload.contentType, content: "" } }, GARBAGE);

			const result = await read(url);

			expect(result.details?.method).toBe("binary");
			expect(result.details?.notes).toHaveLength(1);
			expect(result.details?.notes?.[0]).toStartWith(`${payload.format} rendering failed: `);
			expect(textOutput(result)).toContain(`[Binary content: ${payload.contentType}, 10B] ${url}`);
		});
	}

	const alternates: Array<{ label: string; link: string }> = [
		{ label: "markdown", link: `<link rel="alternate" type="text/markdown" href="//[bad/page.md">` },
		{ label: "feed", link: `<link rel="alternate" type="application/rss+xml" href="//[x]/docs/page/feed.xml">` },
	];
	for (const alternate of alternates) {
		it(`reads past a ${alternate.label} alternate link whose href does not resolve`, async () => {
			const url = `https://example.com/docs/page?v=${Snowflake.next()}`;
			stubSite(
				{ [url]: { contentType: "text/html", content: ARTICLE.replace("{{head}}", alternate.link) } },
				GARBAGE,
			);

			const result = await read(url);

			expect(result.details?.method).toBe("native");
			expect(result.details?.notes).toEqual([]);
			expect(textOutput(result)).toContain("# Heading");
		});
	}

	it("downloads a document that does not convert once, for the converter and the binary notice both", async () => {
		const url = `https://example.com/report-${Snowflake.next()}.pdf`;
		const site = stubSite({ [url]: { contentType: "application/pdf", content: "" } }, GARBAGE);
		vi.spyOn(scrapeServices, "convertDocument").mockResolvedValue({ ok: true, content: "scan" });

		const result = await read(url);

		expect(result.details?.method).toBe("binary");
		expect(result.details?.notes).toEqual(["markit conversion produced no usable output"]);
		expect(textOutput(result)).toContain(`[Binary content: application/pdf, 10B] ${url}`);
		expect(site.downloads).toBe(1);
	});
});
