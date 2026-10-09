/**
 * WHY: the PPTX converter found a slide's notes by renaming the slide part (`slides/slideN.xml` to
 * `notesSlides/notesSlideN.xml`), but a notes part is numbered in the order notes were added, not by
 * slide. A deck whose third slide got notes first showed those notes under the first slide and none under
 * the third. It also joined `ppt/` to a slide's relationship target, so an absolute or percent-encoded
 * target lost the slide, and it found a slide's own relationships, and with them its pictures, only for a
 * part named `ppt/slides/slideN.xml`.
 *
 * The class is a related part located by a guess at its name instead of by the relationship that names
 * it. The sweep builds decks whose slides, pictures and notes sit at conventional names, renamed, and in
 * another directory, with notes parts numbered across their slides, and spells every relationship target
 * each way OPC allows: relative, `./` relative, absolute, percent-encoded and with a fragment. Each deck
 * must convert to the same markdown.
 *
 * Not caught: a relationship kind the converter does not follow (a chart, a SmartArt diagram).
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { convertBufferWithMarkit } from "@veyyon/coding-agent/utils/markit";
import { zip } from "@veyyon/coding-agent/utils/zip";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** How a relationship in the part at `fromPart` writes the member it names. */
const SPELLINGS: Record<string, (fromPart: string, member: string) => string> = {
	relative: (fromPart, member) => path.posix.relative(path.posix.dirname(fromPart), member),
	"dot relative": (fromPart, member) => `./${path.posix.relative(path.posix.dirname(fromPart), member)}`,
	absolute: (_fromPart, member) => `/${member}`,
	"percent-encoded": (fromPart, member) =>
		encodeURI(path.posix.relative(path.posix.dirname(fromPart), member)).replace(/\.(\w+)$/, "%2E$1"),
	fragment: (fromPart, member) => `${path.posix.relative(path.posix.dirname(fromPart), member)}#part`,
};

/** Where the two slide parts sit. */
const SLIDE_LOCATIONS: Record<string, [string, string]> = {
	conventional: ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"],
	renamed: ["ppt/slides/intro.xml", "ppt/slides/outro.xml"],
	"another directory": ["ppt/deck/one.xml", "ppt/deck/two.xml"],
};

interface SlideSpec {
	title: string;
	picture: string;
	media: string;
	notes: string;
	notesPart: string;
}

// The first slide's notes part is numbered 2 and the second's 1, as when notes were added last slide first.
const SLIDES: [SlideSpec, SlideSpec] = [
	{
		title: "Opening",
		picture: "Logo",
		media: "ppt/media/logo one.png",
		notes: "notes of the opening",
		notesPart: "ppt/notesSlides/notesSlide2.xml",
	},
	{
		title: "Closing",
		picture: "Chart",
		media: "ppt/media/chart.png",
		notes: "notes of the closing",
		notesPart: "ppt/notesSlides/notesSlide1.xml",
	},
];

function relsPart(part: string): string {
	return `${path.posix.dirname(part)}/_rels/${path.posix.basename(part)}.rels`;
}

function relationships(rows: string[]): Uint8Array {
	return enc(`<?xml version="1.0"?><Relationships>${rows.join("")}</Relationships>`);
}

function textShape(text: string, placeholder?: string): string {
	const nv = placeholder ? `<p:nvSpPr><p:nvPr><p:ph type="${placeholder}"/></p:nvPr></p:nvSpPr>` : "";
	return `<p:sp>${nv}<p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

function deck(spell: (fromPart: string, member: string) => string, slideParts: [string, string]): Uint8Array {
	const files: Record<string, Uint8Array> = {};
	const presentation = "ppt/presentation.xml";
	files[presentation] = enc(
		`<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>` +
			`<p:sldId id="256" r:id="rIdA"/><p:sldId id="257" r:id="rIdB"/></p:sldIdLst></p:presentation>`,
	);
	files[relsPart(presentation)] = relationships(
		slideParts.map(
			(part, i) =>
				`<Relationship Id="rId${"AB"[i]}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="${spell(presentation, part)}"/>`,
		),
	);
	slideParts.forEach((part, i) => {
		const slide = SLIDES[i]!;
		files[part] = enc(
			`<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>` +
				textShape(slide.title) +
				`<p:pic><p:nvPicPr><p:cNvPr id="2" name="${slide.picture}"/></p:nvPicPr>` +
				`<p:blipFill><a:blip r:embed="rIdPic"/></p:blipFill></p:pic>` +
				`</p:spTree></p:cSld></p:sld>`,
		);
		files[relsPart(part)] = relationships([
			`<Relationship Id="rIdPic" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${spell(part, slide.media)}"/>`,
			`<Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="${spell(part, slide.notesPart)}"/>`,
		]);
		files[slide.media] = enc(slide.picture);
		files[slide.notesPart] = enc(
			`<?xml version="1.0"?><p:notes xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>` +
				textShape("slide image", "sldImg") +
				textShape(slide.notes) +
				`</p:spTree></p:cSld></p:notes>`,
		);
	});
	return zip(files);
}

const EXPECTED = SLIDES.map(
	(slide, i) =>
		`<!-- Slide ${i + 1} -->\n# ${slide.title}\n<!-- image: ${slide.picture} (slide ${i + 1}) -->\n\n### Notes:\n${slide.notes}`,
).join("\n\n");

describe("a PPTX slide", () => {
	for (const [location, slideParts] of Object.entries(SLIDE_LOCATIONS)) {
		for (const [spelling, spell] of Object.entries(SPELLINGS)) {
			it(`reads its picture and notes through relationships (${location} parts, ${spelling} targets)`, async () => {
				const result = await convertBufferWithMarkit(deck(spell, slideParts), ".pptx", undefined, {
					useCache: false,
				});
				expect({ ok: result.ok, content: result.content }).toEqual({ ok: true, content: EXPECTED });
			});
		}
	}

	it("shows no notes for a notes part no relationship names, whatever its number", async () => {
		const files: Record<string, Uint8Array> = {
			"ppt/presentation.xml": enc(
				`<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
			),
			"ppt/_rels/presentation.xml.rels": relationships([
				`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>`,
			]),
			"ppt/slides/slide1.xml": enc(
				`<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>${textShape("Only")}</p:spTree></p:cSld></p:sld>`,
			),
			"ppt/notesSlides/notesSlide1.xml": enc(
				`<?xml version="1.0"?><p:notes xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>${textShape("orphan")}</p:spTree></p:cSld></p:notes>`,
			),
		};
		const result = await convertBufferWithMarkit(zip(files), ".pptx", undefined, { useCache: false });
		expect({ ok: result.ok, content: result.content }).toEqual({ ok: true, content: "<!-- Slide 1 -->\n# Only" });
	});

	it("skips a relationship that names no member of the package", async () => {
		const pic = (embed: string, name: string): string =>
			`<p:pic><p:nvPicPr><p:cNvPr id="2" name="${name}"/></p:nvPicPr><p:blipFill><a:blip r:embed="${embed}"/></p:blipFill></p:pic>`;
		const files: Record<string, Uint8Array> = {
			"ppt/presentation.xml": enc(
				`<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
			),
			"ppt/_rels/presentation.xml.rels": relationships([
				`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>`,
			]),
			"ppt/slides/slide1.xml": enc(
				`<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>${textShape("Linked")}` +
					`${pic("rIdExternal", "Linked picture")}${pic("rIdNoTarget", "Broken picture")}${pic("rIdLocal", "Local picture")}` +
					`</p:spTree></p:cSld></p:sld>`,
			),
			// The external target spells a member the package holds; it still names a file outside the package.
			"ppt/slides/_rels/slide1.xml.rels": relationships([
				`<Relationship Id="rIdExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/shared.png" TargetMode="External"/>`,
				`<Relationship Id="rIdNoTarget" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/>`,
				`<Relationship Id="rIdLocal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/shared.png"/>`,
			]),
			"ppt/media/shared.png": enc("png"),
		};
		const result = await convertBufferWithMarkit(zip(files), ".pptx", undefined, { useCache: false });
		expect({ ok: result.ok, content: result.content }).toEqual({
			ok: true,
			content: "<!-- Slide 1 -->\n# Linked\n<!-- image: Local picture (slide 1) -->",
		});
	});
});
