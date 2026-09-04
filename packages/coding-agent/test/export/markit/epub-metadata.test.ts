import { describe, expect, it } from "bun:test";
import { convertBufferWithMarkit } from "@veyyon/coding-agent/utils/markit";
import { zip } from "@veyyon/coding-agent/utils/zip";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * The EPUB converter had no test at all, and its metadata extraction dropped any
 * value that fast-xml-parser number-parsed. Tag text is number-parsed by
 * default, so a purely numeric title ("1984") or a year-only `dc:date` arrives
 * as a JS number; getText only accepted strings and returned undefined for a
 * number, so the book silently lost its title. These build a minimal EPUB in
 * memory and assert the numeric metadata now survives as text, alongside the
 * ordinary string fields and the spine content, so the whole metadata + spine
 * path is pinned.
 */

const buildEpub = (
	opfMetadata: string,
	chapter = "<html><body><h1>Chapter One</h1><p>Body text.</p></body></html>",
): Uint8Array =>
	zip({
		"META-INF/container.xml": enc(
			`<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
		),
		"OEBPS/content.opf": enc(
			`<?xml version="1.0"?><package><metadata>${opfMetadata}</metadata>` +
				`<manifest><item id="ch1" href="ch1.xhtml"/></manifest>` +
				`<spine><itemref idref="ch1"/></spine></package>`,
		),
		"OEBPS/ch1.xhtml": enc(chapter),
	});

describe("EpubConverter metadata", () => {
	it("keeps a purely numeric title instead of dropping it", async () => {
		const epub = buildEpub(
			`<dc:title>1984</dc:title><dc:creator>George Orwell</dc:creator><dc:language>en</dc:language>`,
		);
		const result = await convertBufferWithMarkit(epub, ".epub");
		expect(result.ok).toBe(true);
		// Without the numeric-text fix the title line is absent because getText
		// returned undefined for the number 1984.
		expect(result.content).toContain("**Title:** 1984");
		expect(result.content).toContain("**Authors:** George Orwell");
		expect(result.content).toContain("**Language:** en");
	});

	it("keeps a year-only dc:date, which is also number-parsed", async () => {
		const epub = buildEpub(`<dc:title>Some Book</dc:title><dc:date>2020</dc:date>`);
		const result = await convertBufferWithMarkit(epub, ".epub");
		expect(result.ok).toBe(true);
		expect(result.content).toContain("**Title:** Some Book");
		expect(result.content).toContain("**Date:** 2020");
	});

	it("converts the spine content after the metadata header", async () => {
		const epub = buildEpub(`<dc:title>Readable</dc:title>`);
		const result = await convertBufferWithMarkit(epub, ".epub");
		expect(result.ok).toBe(true);
		expect(result.content).toContain("Chapter One");
		expect(result.content).toContain("Body text.");
	});
});
