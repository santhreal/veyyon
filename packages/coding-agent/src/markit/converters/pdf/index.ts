import * as path from "node:path";
import type { ConversionResult, Converter, StreamInfo } from "../../types";
import { detectColumns } from "./columns";
import { extractPages, renderImageRegion } from "./extract";
import { stripHeadersFooters } from "./headers";
import type { ImageBlock } from "./index-helpers";
import { EXTENSIONS, MIMETYPES, processColumn } from "./index-helpers";

export class PdfConverter implements Converter {
	name = "pdf";

	accepts(streamInfo: StreamInfo): boolean {
		if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension)) {
			return true;
		}
		if (streamInfo.mimetype && MIMETYPES.some(m => streamInfo.mimetype?.startsWith(m))) {
			return true;
		}
		return false;
	}

	async convert(input: Buffer, streamInfo: StreamInfo): Promise<ConversionResult> {
		const pdfBytes = new Uint8Array(input);
		const pages = await extractPages(pdfBytes);
		stripHeadersFooters(pages);
		const imageDir = streamInfo.imageDir;

		const pageMarkdowns: string[] = [];
		for (const page of pages) {
			const imageBlocks: ImageBlock[] = [];
			if (imageDir && page.images.length > 0) {
				for (const img of page.images) {
					const filename = `${img.id}.png`;
					const filepath = path.join(imageDir, filename);
					try {
						const png = await renderImageRegion(pdfBytes, img);
						await Bun.write(filepath, png);
						imageBlocks.push({ topY: img.topY, markdown: `![${img.id}](${filepath})` });
					} catch {}
				}
			} else if (page.images.length > 0) {
				for (const img of page.images) {
					imageBlocks.push({
						topY: img.topY,
						markdown: `<!-- image: ${img.id} (page ${img.pageNumber}, ${img.bbox.w}x${img.bbox.h}pt) -->`,
					});
				}
			}

			const layout = detectColumns(page.textBoxes);
			if (layout.columnCount > 1 && page.segments.some(s => Math.abs(s.x1 - s.x2) <= 0.8)) {
				const pageXMin = Math.min(...page.textBoxes.map(tb => tb.bounds.left));
				const pageXMax = Math.max(...page.textBoxes.map(tb => tb.bounds.right));
				const pageWidth = pageXMax - pageXMin;
				const minColFraction = 0.3;
				const tooNarrow = layout.columns.some(col => {
					const colXMin = Math.min(...col.map(tb => tb.bounds.left));
					const colXMax = Math.max(...col.map(tb => tb.bounds.right));
					return (colXMax - colXMin) / pageWidth < minColFraction;
				});
				if (tooNarrow) {
					layout.columnCount = 1;
					layout.columns = [page.textBoxes];
					layout.boundaries = [];
				}
			}

			if (layout.columnCount === 1) {
				const md = processColumn(page.pageNumber, page.textBoxes, page.segments, imageBlocks);
				if (md.length > 0) pageMarkdowns.push(md);
			} else {
				const columnMarkdowns: string[] = [];
				for (const colBoxes of layout.columns) {
					const colXMin = Math.min(...colBoxes.map(tb => tb.bounds.left));
					const colXMax = Math.max(...colBoxes.map(tb => tb.bounds.right));
					const margin = 10;
					const colSegments = page.segments.filter(seg => {
						const segXMin = Math.min(seg.x1, seg.x2);
						const segXMax = Math.max(seg.x1, seg.x2);
						return segXMax >= colXMin - margin && segXMin <= colXMax + margin;
					});
					const md = processColumn(
						page.pageNumber,
						colBoxes,
						colSegments,
						columnMarkdowns.length === 0 ? imageBlocks : [],
					);
					if (md.length > 0) columnMarkdowns.push(md);
				}
				const joined = columnMarkdowns.join("\n\n");
				if (joined.length > 0) pageMarkdowns.push(joined);
			}
		}

		return { markdown: pageMarkdowns.join("\n\n") };
	}
}
