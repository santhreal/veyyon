import { describe, expect, it } from "bun:test";
import type { StreamInfo } from "@veyyon/coding-agent/markit";
import { CONVERTIBLE_EXTENSIONS, Markit } from "@veyyon/coding-agent/markit";

/**
 * The Markit registry routes a document buffer to the first converter whose
 * accepts() returns true, aggregates converter errors, and otherwise reports the
 * format as unsupported. That routing + error contract had ZERO tests, and the
 * CONVERTIBLE_EXTENSIONS set is a documented "single source of truth" that other
 * subsystems (read/fetch/CLI) gate on, so a regression here silently mis-routes
 * every attachment. These pin the exact behavior, using inputs whose outcome does
 * not depend on any external asset (the pdf converter needs a mupdf-wasm cache, so
 * the "Conversion failed" branch is driven through the pure-JS zip converters):
 *
 *  - A legacy binary format (.doc/.ppt/.xls/.rtf) has NO converter, so convert()
 *    throws "Unsupported format: <ext>". These live in CONVERTIBLE_EXTENSIONS on
 *    purpose (to route them here for a clean error), but they are never actually
 *    convertible. This is the exact contract the doc comment now states.
 *  - With neither extension nor mimetype the message is "Unsupported format:
 *    unknown"; with only a mimetype it echoes the mimetype.
 *  - A converter that accepts() but whose convert() throws produces
 *    "Conversion failed:\n  <name>: <message>", and the converter NAME proves the
 *    first-accepting-wins routing (a .docx is handled by docx even though the pdf
 *    converter is registered first and rejects it).
 *  - Routing works by mimetype alone (empty extension + application/epub+zip
 *    reaches the epub converter).
 */

const si = (extension: string, mimetype?: string): StreamInfo => ({
	localPath: "x",
	extension,
	filename: `x${extension}`,
	mimetype,
});

const convertError = async (buf: Buffer, stream: StreamInfo): Promise<string> => {
	try {
		await new Markit().convert(buf, stream);
		return "__no_throw__";
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
};

describe("Markit.convert unsupported-format fallback", () => {
	it("reports every legacy binary format as unsupported because no converter accepts it", async () => {
		for (const ext of [".doc", ".ppt", ".xls", ".rtf"]) {
			expect(await convertError(Buffer.from([0xd0, 0xcf]), si(ext))).toBe(`Unsupported format: ${ext}`);
		}
	});

	it("says 'unknown' when there is neither an extension nor a mimetype", async () => {
		expect(await convertError(Buffer.from([0]), si("", undefined))).toBe("Unsupported format: unknown");
	});

	it("echoes the mimetype in the message when there is no extension", async () => {
		expect(await convertError(Buffer.from([0]), si("", "application/x-weird"))).toBe(
			"Unsupported format: application/x-weird",
		);
	});
});

describe("Markit.convert error aggregation and routing", () => {
	it("routes a .docx to the docx converter (first-accepting-wins) and aggregates its failure", async () => {
		// PdfConverter is registered first but rejects .docx; DocxConverter accepts it,
		// then throws on non-zip bytes. The converter name in the aggregate proves which
		// converter ran.
		const message = await convertError(Buffer.from("this is not a zip archive"), si(".docx"));
		const [first, second] = message.split("\n");
		expect(first).toBe("Conversion failed:");
		expect(second?.startsWith("  docx: ")).toBe(true);
	});

	it("routes by mimetype alone when the extension is empty", async () => {
		// application/epub+zip -> epub converter accepts by mimetype, then fails on non-zip bytes.
		const message = await convertError(Buffer.from("not a zip"), si("", "application/epub+zip"));
		expect(message.split("\n")[0]).toBe("Conversion failed:");
		expect(message.split("\n")[1]?.startsWith("  epub: ")).toBe(true);
	});
});

describe("CONVERTIBLE_EXTENSIONS routing gate", () => {
	it("contains exactly the nine document extensions veyyon routes to markit", () => {
		expect([...CONVERTIBLE_EXTENSIONS].sort()).toEqual(
			[".doc", ".docx", ".epub", ".pdf", ".ppt", ".pptx", ".rtf", ".xls", ".xlsx"].sort(),
		);
	});

	it("advertises legacy binary formats that are gate-only, never actually convertible", async () => {
		// These are in the gate on purpose (route here for a clean error) but always fail.
		for (const ext of [".doc", ".ppt", ".xls", ".rtf"]) {
			expect(CONVERTIBLE_EXTENSIONS.has(ext)).toBe(true);
			expect(await convertError(Buffer.from([0]), si(ext))).toBe(`Unsupported format: ${ext}`);
		}
	});

	it("includes every extension that does have a registered converter", () => {
		for (const ext of [".pdf", ".docx", ".pptx", ".xlsx", ".epub"]) {
			expect(CONVERTIBLE_EXTENSIONS.has(ext)).toBe(true);
		}
	});
});
