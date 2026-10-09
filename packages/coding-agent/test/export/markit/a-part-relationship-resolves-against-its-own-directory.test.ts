/**
 * WHY: the PPTX and XLSX converters read every related part (a slide, a sheet, a picture, a notes page)
 * through `readPartRelationships`, so the rules it applies decide which members a document's markdown is
 * built from. A target resolves against the directory of the part that owns the relationship, a part at
 * the package root keeps its `.rels` in the root `_rels/` directory, and a relationship that names no
 * member of the package is left out. The converter suites prove the rules through whole documents; this
 * suite pins them where both converters share them.
 *
 * Not caught: a relationship kind that only one converter follows.
 */
import { describe, expect, it } from "bun:test";
import {
	readPartRelationships,
	relationshipOfKind,
} from "@veyyon/coding-agent/export/markit/converters/opc-relationships";
import { unzip, zip } from "@veyyon/coding-agent/utils/zip";
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text" });

function rels(...rows: string[]): Uint8Array {
	return new TextEncoder().encode(`<?xml version="1.0"?><Relationships>${rows.join("")}</Relationships>`);
}

function read(files: Record<string, Uint8Array>, partPath: string) {
	return Object.fromEntries(readPartRelationships(unzip(zip(files)), parser, partPath));
}

describe("readPartRelationships", () => {
	it("resolves each target against the directory of the part that owns it", () => {
		const relationships = read(
			{
				"ppt/slides/_rels/intro.xml.rels": rels(
					`<Relationship Id="a" Type="t/image" Target="../media/one%20two.png#frame"/>`,
					`<Relationship Id="b" Type="t/notesSlide" Target="/ppt/notesSlides/notesSlide4.xml"/>`,
					`<Relationship Id="c" Type="t/slideLayout" Target="./layouts/l.xml"/>`,
				),
			},
			"ppt/slides/intro.xml",
		);
		expect(relationships).toEqual({
			a: { type: "t/image", member: "ppt/media/one two.png" },
			b: { type: "t/notesSlide", member: "ppt/notesSlides/notesSlide4.xml" },
			c: { type: "t/slideLayout", member: "ppt/slides/layouts/l.xml" },
		});
	});

	it("reads a root-level part's relationships from the root _rels directory", () => {
		const relationships = read(
			{ "_rels/workbook.xml.rels": rels(`<Relationship Id="s1" Type="t/worksheet" Target="sheets/s1.xml"/>`) },
			"workbook.xml",
		);
		expect(relationships).toEqual({ s1: { type: "t/worksheet", member: "sheets/s1.xml" } });
	});

	it("leaves out a relationship with no Id, no Target, or an external target", () => {
		const relationships = read(
			{
				"xl/_rels/workbook.xml.rels": rels(
					`<Relationship Type="t/worksheet" Target="worksheets/a.xml"/>`,
					`<Relationship Id="noTarget" Type="t/worksheet"/>`,
					`<Relationship Id="link" Type="t/hyperlink" Target="worksheets/b.xml" TargetMode="External"/>`,
					`<Relationship Id="kept" Target="worksheets/c.xml"/>`,
				),
			},
			"xl/workbook.xml",
		);
		expect(relationships).toEqual({ kept: { type: "", member: "xl/worksheets/c.xml" } });
	});

	it("is empty for a part with no .rels part", () => {
		expect(read({ "xl/workbook.xml": new Uint8Array(0) }, "xl/workbook.xml")).toEqual({});
	});
});

describe("relationshipOfKind", () => {
	it("matches the last segment of a transitional or strict OOXML type, and nothing that only contains it", () => {
		const files = {
			"ppt/slides/_rels/slide1.xml.rels": rels(
				`<Relationship Id="master" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlideMaster" Target="../m.xml"/>`,
				`<Relationship Id="strict" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/notesSlide" Target="../notesSlides/n.xml"/>`,
			),
		};
		const relationships = readPartRelationships(unzip(zip(files)), parser, "ppt/slides/slide1.xml");
		expect(relationshipOfKind(relationships, "notesSlide")).toEqual({
			type: "http://purl.oclc.org/ooxml/officeDocument/relationships/notesSlide",
			member: "ppt/notesSlides/n.xml",
		});
		expect(relationshipOfKind(relationships, "image")).toBeUndefined();
	});
});
