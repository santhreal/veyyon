// Adapted from markit-ai (MIT). See ../NOTICE.
import * as path from "node:path";
import { renderMarkdownTable } from "@veyyon/utils/markdown-table";
import { XMLParser } from "fast-xml-parser";
import { type Unzipped, unzip, unzipText } from "../../../utils/zip";
import type { ConversionResult, Converter, StreamInfo } from "../types";
import { type PartRelationship, readPartRelationships, relationshipOfKind } from "./opc-relationships";
import { xmlNodeText } from "./xml-text";

const EXTENSIONS = [".pptx"];
const MIMETYPES = ["application/vnd.openxmlformats-officedocument.presentationml.presentation"];
const PRESENTATION_PART = "ppt/presentation.xml";
const NUMBERED_SLIDE_PART = /^ppt\/slides\/slide(\d+)\.xml$/;

/** A text value: bare string/number, or a `{ "#text" }` node when the element carries attributes. */
type XmlText = string | number | { "#text"?: string };

interface TextRun {
	"a:t"?: XmlText;
}
interface Paragraph {
	"a:r"?: TextRun | TextRun[];
}
interface TextBody {
	"a:p"?: Paragraph | Paragraph[];
}
interface CNvPr {
	"@_name": string;
}
interface Placeholder {
	"@_type": string;
}
interface NvPr {
	"p:ph"?: Placeholder;
}
interface NvSpPr {
	"p:cNvPr"?: CNvPr;
	"p:nvPr"?: NvPr;
}
interface NvPicPr {
	"p:cNvPr"?: CNvPr;
}
interface Shape {
	"p:txBody"?: TextBody;
	"p:nvSpPr"?: NvSpPr;
}
interface Blip {
	"@_r:embed": string;
}
interface BlipFill {
	"a:blip"?: Blip;
}
interface Picture {
	"p:blipFill"?: BlipFill;
	"p:nvSpPr"?: NvSpPr;
	"p:nvPicPr"?: NvPicPr;
}
interface TableCell {
	"a:txBody"?: TextBody;
}
interface TableRow {
	"a:tc"?: TableCell | TableCell[];
}
interface Table {
	"a:tr"?: TableRow | TableRow[];
}
interface GraphicData {
	"a:tbl"?: Table;
}
interface Graphic {
	"a:graphicData"?: GraphicData;
}
interface GraphicFrame {
	"a:graphic"?: Graphic;
}
interface SpTree {
	"p:sp"?: Shape | Shape[];
	"p:pic"?: Picture | Picture[];
	"p:graphicFrame"?: GraphicFrame | GraphicFrame[];
}
interface CSld {
	"p:spTree"?: SpTree;
}
interface SlideDoc {
	"p:sld"?: { "p:cSld"?: CSld };
}
interface NotesDoc {
	"p:notes"?: { "p:cSld"?: CSld };
}
interface SldId {
	"@_r:id": string;
}
interface PresentationDoc {
	"p:presentation"?: { "p:sldIdLst"?: { "p:sldId"?: SldId | SldId[] } };
}

/** Where pictures are written, and how many have been numbered so far across every slide. */
interface ImageSink {
	dir: string | undefined;
	count: number;
}

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
		const slidePaths = slidePartPaths(entries, parser);
		const images: ImageSink = { dir: streamInfo.imageDir, count: 0 };
		const sections: string[] = [];
		for (let i = 0; i < slidePaths.length; i++) {
			const section = await slideMarkdown(entries, parser, slidePaths[i]!, i + 1, images);
			if (section !== undefined) sections.push(section);
		}
		return { markdown: sections.join("\n\n").trim() };
	}
}

/**
 * The slide parts in presentation order, each found through the presentation's relationship for its
 * `p:sldId`. When none resolves, every `ppt/slides/slideN.xml` member in order of `N`.
 */
function slidePartPaths(entries: Unzipped, parser: XMLParser): string[] {
	const presXml = unzipText(entries, PRESENTATION_PART);
	if (!presXml) throw new Error("Invalid PPTX: missing presentation.xml");
	const pres = parser.parse(presXml) as PresentationDoc;
	const relationships = readPartRelationships(entries, parser, PRESENTATION_PART);
	const paths: string[] = [];
	for (const sld of toList(pres["p:presentation"]?.["p:sldIdLst"]?.["p:sldId"])) {
		const relationship = relationships.get(sld["@_r:id"]);
		if (relationship) paths.push(relationship.member);
	}
	if (paths.length > 0) return paths;
	const numbered: Array<[number, string]> = [];
	for (const member of Object.keys(entries)) {
		const match = NUMBERED_SLIDE_PART.exec(member);
		if (match) numbered.push([Number(match[1]), member]);
	}
	return numbered.sort((a, b) => a[0] - b[0]).map(([, member]) => member);
}

/**
 * A slide's markdown: the text of each shape, the first as a heading, then its pictures, its tables and
 * its notes. Undefined when the slide part is absent or holds no shape tree.
 */
async function slideMarkdown(
	entries: Unzipped,
	parser: XMLParser,
	slidePath: string,
	slideNumber: number,
	images: ImageSink,
): Promise<string | undefined> {
	const slideXml = unzipText(entries, slidePath);
	if (!slideXml) return undefined;
	const spTree = (parser.parse(slideXml) as SlideDoc)["p:sld"]?.["p:cSld"]?.["p:spTree"];
	if (!spTree) return undefined;
	const relationships = readPartRelationships(entries, parser, slidePath);
	const lines = [`<!-- Slide ${slideNumber} -->`];
	let heading = true;
	for (const shape of toList(spTree["p:sp"])) {
		const text = shapeText(shape);
		if (!text) continue;
		lines.push(heading ? `# ${text}` : text);
		heading = false;
	}
	for (const pic of toList(spTree["p:pic"])) {
		const line = await pictureLine(entries, pic, relationships, slideNumber, images);
		if (line) lines.push(line);
	}
	for (const frame of toList(spTree["p:graphicFrame"])) {
		const table = tableMarkdown(frame);
		if (table) lines.push(table);
	}
	const notes = notesText(entries, parser, relationships);
	if (notes) lines.push("\n### Notes:", notes);
	return lines.join("\n");
}

/**
 * The line for a picture whose image part the archive holds: a link to the copy written to `images.dir`,
 * or a comment naming the picture when no directory is set or the write fails.
 */
async function pictureLine(
	entries: Unzipped,
	pic: Picture,
	relationships: Map<string, PartRelationship>,
	slideNumber: number,
	images: ImageSink,
): Promise<string | undefined> {
	const embed = pic["p:blipFill"]?.["a:blip"]?.["@_r:embed"];
	const member = embed ? relationships.get(embed)?.member : undefined;
	const bytes = member ? entries[member] : undefined;
	if (!member || !bytes) return undefined;
	images.count++;
	const name =
		pic["p:nvSpPr"]?.["p:cNvPr"]?.["@_name"] || pic["p:nvPicPr"]?.["p:cNvPr"]?.["@_name"] || `image_${images.count}`;
	const comment = `<!-- image: ${name} (slide ${slideNumber}) -->`;
	if (!images.dir) return comment;
	try {
		const ext = member.split(".").pop() || "png";
		const filepath = path.join(images.dir, `slide${slideNumber}_${images.count}.${ext}`);
		await Bun.write(filepath, bytes);
		return `![${name}](${filepath})`;
	} catch {
		return comment;
	}
}

/** The text of the notes slide a slide relates to, without its slide-image placeholder; "" when it has none. */
function notesText(entries: Unzipped, parser: XMLParser, slideRelationships: Map<string, PartRelationship>): string {
	const notesPart = relationshipOfKind(slideRelationships, "notesSlide");
	const notesXml = notesPart ? unzipText(entries, notesPart.member) : undefined;
	if (!notesXml) return "";
	const spTree = (parser.parse(notesXml) as NotesDoc)["p:notes"]?.["p:cSld"]?.["p:spTree"];
	const texts: string[] = [];
	for (const shape of toList(spTree?.["p:sp"])) {
		if (shape["p:nvSpPr"]?.["p:nvPr"]?.["p:ph"]?.["@_type"] === "sldImg") continue;
		const text = shapeText(shape);
		if (text) texts.push(text);
	}
	return texts.join("\n");
}

function shapeText(shape: Shape): string {
	const txBody = shape["p:txBody"];
	return txBody ? textFromBody(txBody) : "";
}

function tableMarkdown(frame: GraphicFrame): string | undefined {
	const rows = toList(frame?.["a:graphic"]?.["a:graphicData"]?.["a:tbl"]?.["a:tr"]);
	if (rows.length === 0) return undefined;
	const cells = rows.map(row =>
		toList(row["a:tc"]).map(cell => (cell["a:txBody"] ? textFromBody(cell["a:txBody"]) : "")),
	);
	return renderMarkdownTable(cells) || undefined;
}

function toList<T>(val: T | T[] | undefined): T[] {
	if (!val) return [];
	return Array.isArray(val) ? val : [val];
}

/**
 * Concatenate every run of every paragraph in a PPTX text body.
 *
 * Runs inside a paragraph join with the empty string: an `<a:r>` boundary marks
 * a formatting change (bold, color, language), not a word break, so "Hello"
 * stored as two runs must render as "Hello" and never "Hel lo". Paragraphs join
 * with a newline (a table cell later collapses that to a space through
 * `escapeMarkdownTableCell`). This is the single owner of text-body extraction:
 * slide body text and table cells both route through it so they cannot disagree
 * on run spacing.
 */
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
