import * as path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { renderMarkdownTable } from "../../utils/markdown-table";
import { resolveArchiveMemberPath, unzip, unzipText } from "../../utils/zip";
import type { ConversionResult, Converter, StreamInfo } from "../types";
import type {
	GraphicFrame,
	NotesDoc,
	PresentationDoc,
	RelationshipsDoc,
	Shape,
	SlideDoc,
	TextBody,
} from "./pptx-helpers";

import { EXTENSIONS, MIMETYPES } from "./pptx-helpers";
import { xmlNodeText } from "./xml-text";

export class PptxConverter implements Converter {
	name = "pptx";

	accepts(streamInfo: StreamInfo): boolean {
		if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension)) return true;
		if (streamInfo.mimetype && MIMETYPES.some(m => streamInfo.mimetype?.startsWith(m))) return true;
		return false;
	}

	async convert(input: Buffer, streamInfo: StreamInfo): Promise<ConversionResult> {
		const entries = unzip(input);
		const parser = new XMLParser({
			ignoreAttributes: false,
			attributeNamePrefix: "@_",
			textNodeName: "#text",
			processEntities: { maxTotalExpansions: 1_000_000 },
		});
		const presXml = unzipText(entries, "ppt/presentation.xml");
		if (!presXml) throw new Error("Invalid PPTX: missing presentation.xml");
		const pres = parser.parse(presXml) as PresentationDoc;
		const sldIdList = pres["p:presentation"]?.["p:sldIdLst"]?.["p:sldId"];
		const sldIds = Array.isArray(sldIdList) ? sldIdList : sldIdList ? [sldIdList] : [];
		const relsXml = unzipText(entries, "ppt/_rels/presentation.xml.rels");
		const rels = relsXml ? (parser.parse(relsXml) as RelationshipsDoc) : null;
		const relList = rels?.Relationships?.Relationship;
		const relArray = Array.isArray(relList) ? relList : relList ? [relList] : [];
		const relMap = new Map<string, string>();
		for (const r of relArray) {
			relMap.set(r["@_Id"], r["@_Target"]);
		}
		const slidePaths: string[] = [];
		for (const sld of sldIds) {
			const rId = sld["@_r:id"];
			const target = relMap.get(rId);
			if (target) slidePaths.push(`ppt/${target}`);
		}
		if (slidePaths.length === 0) {
			const slideFiles = Object.keys(entries)
				.filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
				.sort((a, b) => {
					const na = parseInt(a.match(/slide(\d+)/)?.[1] || "0", 10);
					const nb = parseInt(b.match(/slide(\d+)/)?.[1] || "0", 10);
					return na - nb;
				});
			for (let si = 0; si < slideFiles.length; si++) slidePaths.push(slideFiles[si]!);
		}
		const imageDir = streamInfo.imageDir;
		const sections: string[] = [];
		let imageCount = 0;
		for (let i = 0; i < slidePaths.length; i++) {
			const slideXml = unzipText(entries, slidePaths[i]);
			if (!slideXml) continue;
			const slide = parser.parse(slideXml) as SlideDoc;
			const spTree = slide["p:sld"]?.["p:cSld"]?.["p:spTree"];
			if (!spTree) continue;
			const slideRelsPath = `${slidePaths[i].replace("slides/slide", "slides/_rels/slide")}.rels`;
			const slideRelsXml = unzipText(entries, slideRelsPath);
			const slideRelMap = new Map<string, string>();
			if (slideRelsXml) {
				const slideRels = parser.parse(slideRelsXml) as RelationshipsDoc;
				const relItems = toList(slideRels?.Relationships?.Relationship);
				for (const r of relItems) {
					slideRelMap.set(r["@_Id"], r["@_Target"]);
				}
			}
			const slideLines = [`<!-- Slide ${i + 1} -->`];
			const shapes = spTree["p:sp"];
			const shapeList = Array.isArray(shapes) ? shapes : shapes ? [shapes] : [];
			let isTitle = true;
			for (const shape of shapeList) {
				const text = this.extractText(shape);
				if (!text) continue;
				if (isTitle) {
					slideLines.push(`# ${text}`);
					isTitle = false;
				} else {
					slideLines.push(text);
				}
			}
			const pics = toList(spTree["p:pic"]);
			for (const pic of pics) {
				const blipFill = pic["p:blipFill"];
				const rEmbed = blipFill?.["a:blip"]?.["@_r:embed"];
				if (!rEmbed) continue;
				const target = slideRelMap.get(rEmbed);
				if (!target) continue;
				const normalizedPath = resolveArchiveMemberPath("ppt/slides", target);
				const buf = entries[normalizedPath];
				if (!buf) continue;
				imageCount++;
				const name =
					pic["p:nvSpPr"]?.["p:cNvPr"]?.["@_name"] ||
					pic["p:nvPicPr"]?.["p:cNvPr"]?.["@_name"] ||
					`image_${imageCount}`;
				if (imageDir) {
					try {
						const ext = normalizedPath.split(".").pop() || "png";
						const filename = `slide${i + 1}_${imageCount}.${ext}`;
						const filepath = path.join(imageDir, filename);
						await Bun.write(filepath, buf);
						slideLines.push(`![${name}](${filepath})`);
					} catch {
						slideLines.push(`<!-- image: ${name} (slide ${i + 1}) -->`);
					}
				} else {
					slideLines.push(`<!-- image: ${name} (slide ${i + 1}) -->`);
				}
			}
			const graphicFrames = spTree["p:graphicFrame"];
			const gfList = Array.isArray(graphicFrames) ? graphicFrames : graphicFrames ? [graphicFrames] : [];
			for (const gf of gfList) {
				const table = this.extractTable(gf);
				if (table) slideLines.push(table);
			}
			const noteFile = slidePaths[i].replace("slides/slide", "notesSlides/notesSlide");
			const noteXml = unzipText(entries, noteFile);
			if (noteXml) {
				const note = parser.parse(noteXml) as NotesDoc;
				const noteSpTree = note["p:notes"]?.["p:cSld"]?.["p:spTree"];
				if (noteSpTree) {
					const noteShapes = noteSpTree["p:sp"];
					const noteList = Array.isArray(noteShapes) ? noteShapes : noteShapes ? [noteShapes] : [];
					const noteTexts: string[] = [];
					for (const ns of noteList) {
						const phType = ns["p:nvSpPr"]?.["p:nvPr"]?.["p:ph"]?.["@_type"];
						if (phType === "sldImg") continue;
						const t = this.extractText(ns);
						if (t) noteTexts.push(t);
					}
					if (noteTexts.length > 0) {
						slideLines.push("\n### Notes:");
						slideLines.push(noteTexts.join("\n"));
					}
				}
			}
			sections.push(slideLines.join("\n"));
		}
		return { markdown: sections.join("\n\n").trim() };
	}

	extractText(shape: Shape): string {
		const txBody = shape["p:txBody"];
		return txBody ? textFromBody(txBody) : "";
	}

	extractTable(gf: GraphicFrame): string | null {
		const tbl = gf?.["a:graphic"]?.["a:graphicData"]?.["a:tbl"];
		if (!tbl) return null;
		const rows = tbl["a:tr"];
		const rowList = Array.isArray(rows) ? rows : rows ? [rows] : [];
		if (rowList.length === 0) return null;
		const mdRows: string[][] = [];
		for (const row of rowList) {
			const cells = row["a:tc"];
			const cellList = Array.isArray(cells) ? cells : cells ? [cells] : [];
			const cellTexts: string[] = [];
			for (const cell of cellList) {
				const txBody = cell["a:txBody"];
				cellTexts.push(txBody ? textFromBody(txBody) : "");
			}
			mdRows.push(cellTexts);
		}
		if (mdRows.length === 0) return null;
		return renderMarkdownTable(mdRows) || null;
	}
}

function toList<T>(val: T | T[] | undefined): T[] {
	if (!val) return [];
	return Array.isArray(val) ? val : [val];
}

function textFromBody(txBody: TextBody): string {
	const lines: string[] = [];
	for (const p of toList(txBody["a:p"])) {
		const parts: string[] = [];
		for (const r of toList(p["a:r"])) {
			const t = r["a:t"];
			if (t != null) parts.push(xmlNodeText(t));
		}
		if (parts.length > 0) lines.push(parts.join(""));
	}
	return lines.join("\n").trim();
}
