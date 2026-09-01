export const EXTENSIONS = [".pptx"];
export const MIMETYPES = ["application/vnd.openxmlformats-officedocument.presentationml.presentation"];

export type XmlText = string | number | { "#text"?: string };

export interface TextRun {
	"a:t"?: XmlText;
}
export interface Paragraph {
	"a:r"?: TextRun | TextRun[];
}
export interface TextBody {
	"a:p"?: Paragraph | Paragraph[];
}
export interface CNvPr {
	"@_name": string;
}
export interface Placeholder {
	"@_type": string;
}
export interface NvPr {
	"p:ph"?: Placeholder;
}
export interface NvSpPr {
	"p:cNvPr"?: CNvPr;
	"p:nvPr"?: NvPr;
}
export interface NvPicPr {
	"p:cNvPr"?: CNvPr;
}
export interface Shape {
	"p:txBody"?: TextBody;
	"p:nvSpPr"?: NvSpPr;
}
export interface Blip {
	"@_r:embed": string;
}
export interface BlipFill {
	"a:blip"?: Blip;
}
export interface Picture {
	"p:blipFill"?: BlipFill;
	"p:nvSpPr"?: NvSpPr;
	"p:nvPicPr"?: NvPicPr;
}
export interface TableCell {
	"a:txBody"?: TextBody;
}
export interface TableRow {
	"a:tc"?: TableCell | TableCell[];
}
export interface Table {
	"a:tr"?: TableRow | TableRow[];
}
export interface GraphicData {
	"a:tbl"?: Table;
}
export interface Graphic {
	"a:graphicData"?: GraphicData;
}
export interface GraphicFrame {
	"a:graphic"?: Graphic;
}
export interface SpTree {
	"p:sp"?: Shape | Shape[];
	"p:pic"?: Picture | Picture[];
	"p:graphicFrame"?: GraphicFrame | GraphicFrame[];
}
export interface CSld {
	"p:spTree"?: SpTree;
}
export interface SlideDoc {
	"p:sld"?: { "p:cSld"?: CSld };
}
export interface NotesDoc {
	"p:notes"?: { "p:cSld"?: CSld };
}
export interface SldId {
	"@_r:id": string;
}
export interface PresentationDoc {
	"p:presentation"?: { "p:sldIdLst"?: { "p:sldId"?: SldId | SldId[] } };
}
export interface Relationship {
	"@_Id": string;
	"@_Target": string;
}
export interface RelationshipsDoc {
	Relationships?: { Relationship?: Relationship | Relationship[] };
}
