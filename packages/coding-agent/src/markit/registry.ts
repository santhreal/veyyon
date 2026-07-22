// Adapted from markit-ai (MIT). See ./NOTICE.
import * as path from "node:path";
import { DocxConverter } from "./converters/docx";
import { EpubConverter } from "./converters/epub";
import { PdfConverter } from "./converters/pdf";
import { PptxConverter } from "./converters/pptx";
import { XlsxConverter } from "./converters/xlsx";
import type { ConversionResult, Converter, MarkitOptions, StreamInfo } from "./types";

/**
 * Routing gate for the markit document pipeline. Single source of truth for
 * callers that decide whether to hand a file to markit before markit itself
 * ever sees it (CLI attachment handling, `read`/`fetch` content-type sniffing).
 *
 * This is NOT a promise that every listed extension converts successfully. Only
 * `.pdf`, `.docx`, `.pptx`, `.xlsx`, and `.epub` have a registered converter. The
 * legacy binary formats `.doc`, `.ppt`, `.xls`, and `.rtf` are listed on purpose
 * so callers route them here and get a clean `Unsupported format` error from
 * {@link Markit.convert}, instead of the text-read fallback decoding their binary
 * bytes as garbage UTF-8. Adding an extension here without a converter that
 * `accepts()` it means files of that type always fail with `Unsupported format`.
 */
export const CONVERTIBLE_EXTENSIONS = new Set([
	".pdf",
	".doc",
	".docx",
	".ppt",
	".pptx",
	".xls",
	".xlsx",
	".rtf",
	".epub",
]);

/**
 * In-house document → markdown engine (replaces the `markit-ai` package).
 *
 * Only the document converters veyyon routes are registered (pdf, docx, pptx,
 * xlsx, epub). The first converter whose `accepts()` returns true and whose
 * `convert()` succeeds wins.
 */
export class Markit {
	readonly #converters: readonly Converter[];
	readonly #options: MarkitOptions;

	constructor(options: MarkitOptions = {}) {
		this.#options = options;
		this.#converters = [
			new PdfConverter(),
			new DocxConverter(),
			new PptxConverter(),
			new XlsxConverter(),
			new EpubConverter(),
		];
	}

	async convertFile(filePath: string, extra?: { imageDir?: string }): Promise<ConversionResult> {
		const buffer = Buffer.from(await Bun.file(filePath).arrayBuffer());
		const streamInfo: StreamInfo = {
			localPath: filePath,
			extension: path.extname(filePath).toLowerCase(),
			filename: path.basename(filePath),
			...extra,
		};
		return this.convert(buffer, streamInfo);
	}

	async convert(input: Buffer, streamInfo: StreamInfo): Promise<ConversionResult> {
		const errors: { converter: string; error: Error }[] = [];
		for (const converter of this.#converters) {
			if (!converter.accepts(streamInfo)) continue;
			try {
				return await converter.convert(input, streamInfo, this.#options);
			} catch (err) {
				errors.push({ converter: converter.name, error: err instanceof Error ? err : new Error(String(err)) });
			}
		}
		if (errors.length > 0) {
			const details = errors.map(e => `  ${e.converter}: ${e.error.message}`).join("\n");
			throw new Error(`Conversion failed:\n${details}`);
		}
		throw new Error(`Unsupported format: ${streamInfo.extension || streamInfo.mimetype || "unknown"}`);
	}
}
