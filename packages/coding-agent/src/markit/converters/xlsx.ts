import { XMLParser } from "fast-xml-parser";
import { renderMarkdownTable } from "../../utils/markdown-table";
import { resolveArchiveMemberPath, unzip, unzipText } from "../../utils/zip";
import type { ConversionResult, Converter, StreamInfo } from "../types";
import { xmlNodeText } from "./xml-text";

const EXTENSIONS = [".xlsx"];
const MIMETYPES = ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];

type XmlText = string | number | { "#text"?: string };

interface RichTextRun {
	t?: XmlText;
}
interface StringItem {
	t?: XmlText;
	r?: RichTextRun | RichTextRun[];
}
interface Cell {
	"@_t"?: string;
	"@_r"?: string;
	v?: string | number;
	is?: StringItem;
}
interface Row {
	c?: Cell | Cell[];
}
interface WorksheetDoc {
	worksheet?: { sheetData?: { row?: Row | Row[] } };
}
interface Sheet {
	"@_name": string;
	"@_r:id": string;
}
interface WorkbookDoc {
	workbook?: { sheets?: { sheet?: Sheet | Sheet[] } };
}
interface SharedStringsDoc {
	sst?: { si?: StringItem | StringItem[] };
}
interface Relationship {
	"@_Id": string;
	"@_Target": string;
}
interface RelationshipsDoc {
	Relationships?: { Relationship?: Relationship | Relationship[] };
}

export class XlsxConverter implements Converter {
	name = "xlsx";

	accepts(streamInfo: StreamInfo): boolean {
		if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension)) return true;
		if (streamInfo.mimetype && MIMETYPES.some(m => streamInfo.mimetype?.startsWith(m))) return true;
		return false;
	}

	async convert(input: Buffer, _streamInfo: StreamInfo): Promise<ConversionResult> {
		const entries = unzip(input);
		const parser = new XMLParser({
			ignoreAttributes: false,
			attributeNamePrefix: "@_",
			textNodeName: "#text",
			processEntities: { maxTotalExpansions: 1_000_000 },
		});
		const ssXml = unzipText(entries, "xl/sharedStrings.xml");
		const ss = ssXml ? (parser.parse(ssXml) as SharedStringsDoc) : null;
		const siList = ss?.sst?.si;
		const shared = toArray(siList);
		const wbXml = unzipText(entries, "xl/workbook.xml");
		if (!wbXml) throw new Error("Invalid XLSX: missing workbook.xml");
		const wb = parser.parse(wbXml) as WorkbookDoc;
		const sheets = toArray(wb.workbook?.sheets?.sheet);
		const relsXml = unzipText(entries, "xl/_rels/workbook.xml.rels");
		const rels = relsXml ? (parser.parse(relsXml) as RelationshipsDoc) : null;
		const relList = toArray(rels?.Relationships?.Relationship);
		const relMap = new Map<string, string>();
		for (const r of relList) {
			relMap.set(r["@_Id"], r["@_Target"]);
		}
		const sections: string[] = [];
		for (const sheet of sheets) {
			const sheetName = sheet["@_name"];
			const rId = sheet["@_r:id"];
			const target = relMap.get(rId);
			if (!target) continue;
			const sheetPath = resolveArchiveMemberPath("xl", target);
			const sheetXml = unzipText(entries, sheetPath);
			if (!sheetXml) continue;
			const parsed = parser.parse(sheetXml) as WorksheetDoc;
			const rows = toArray(parsed.worksheet?.sheetData?.row);
			if (rows.length === 0) continue;
			const tableRows: string[][] = [];
			for (const row of rows) {
				const cells = toArray(row.c).map(cell => ({
					ref: cell["@_r"],
					value: this.getCellValue(cell, shared),
				}));
				tableRows.push(positionRowValues(cells));
			}
			if (tableRows.length === 0) continue;
			const table = renderMarkdownTable(tableRows);
			if (!table) continue;
			sections.push(`## ${sheetName}`);
			sections.push(table);
		}
		return { markdown: sections.join("\n\n") };
	}

	getCellValue(cell: Cell, shared: StringItem[]): string {
		if (cell["@_t"] === "s") {
			return this.getSharedString(shared, Number(cell.v));
		}
		if (cell["@_t"] === "inlineStr") {
			const is = cell.is;
			if (!is) return "";
			if (is.t != null) return textValue(is.t);
			if (is.r)
				return toArray(is.r)
					.map(r => textValue(r.t))
					.join("");
			return "";
		}
		if (cell["@_t"] === "b") {
			return cell.v === 1 || cell.v === "1" ? "TRUE" : "FALSE";
		}
		if (cell.v != null) return String(cell.v);
		return "";
	}

	getSharedString(shared: StringItem[], idx: number): string {
		const si = shared[idx];
		if (!si) return "";
		if (si.t != null) return textValue(si.t);
		if (si.r) {
			return toArray(si.r)
				.map(r => textValue(r.t))
				.join("");
		}
		return "";
	}
}

function textValue(t: XmlText | undefined): string {
	return xmlNodeText(t);
}

export function columnRefToIndex(ref: string): number | undefined {
	const match = /^[A-Za-z]+/.exec(ref);
	if (!match) return undefined;
	let index = 0;
	for (const ch of match[0].toUpperCase()) {
		index = index * 26 + (ch.charCodeAt(0) - 64);
	}
	return index - 1;
}

export function positionRowValues(cells: { ref: string | undefined; value: string }[]): string[] {
	const row: string[] = [];
	let next = 0;
	for (const { ref, value } of cells) {
		const col = ref !== undefined ? columnRefToIndex(ref) : undefined;
		const target = col ?? next;
		while (row.length <= target) row.push("");
		row[target] = value;
		next = target + 1;
	}
	return row;
}

function toArray<T>(val: T | T[] | undefined): T[] {
	if (!val) return [];
	return Array.isArray(val) ? val : [val];
}
