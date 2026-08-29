export const EXTENSIONS = [".xlsx"];
export const MIMETYPES = ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];

export type XmlText = string | number | { "#text"?: string };

export interface RichTextRun {
	t?: XmlText;
}
export interface StringItem {
	t?: XmlText;
	r?: RichTextRun | RichTextRun[];
}
export interface Cell {
	"@_t"?: string;
	"@_r"?: string;
	v?: string | number;
	is?: StringItem;
}
export interface Row {
	c?: Cell | Cell[];
}
export interface WorksheetDoc {
	worksheet?: { sheetData?: { row?: Row | Row[] } };
}
export interface Sheet {
	"@_name": string;
	"@_r:id": string;
}
export interface WorkbookDoc {
	workbook?: { sheets?: { sheet?: Sheet | Sheet[] } };
}
export interface SharedStringsDoc {
	sst?: { si?: StringItem | StringItem[] };
}
export interface Relationship {
	"@_Id": string;
	"@_Target": string;
}
export interface RelationshipsDoc {
	Relationships?: { Relationship?: Relationship | Relationship[] };
}
