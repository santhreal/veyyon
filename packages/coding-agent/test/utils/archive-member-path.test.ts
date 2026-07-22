import { describe, expect, it } from "bun:test";
import { resolveArchiveMemberPath } from "@veyyon/coding-agent/utils/zip";

/**
 * resolveArchiveMemberPath is the single owner that maps a container-relative
 * reference (an EPUB manifest href, or an OPC relationship Target) to the exact
 * zip entry key the converters read. It locks a real fix and a deduplication:
 * every archive converter previously resolved these refs itself, and each did it
 * wrong in a different way. The EPUB converter did a naive `${base}/${href}` join,
 * so a percent-encoded, `#fragment`-carrying, or `./` / `../` href (all legal
 * container URIs, common when the OPF or a slide rel points across directories)
 * produced a key that never matched a zip entry and the part was SILENTLY dropped.
 * The PPTX image resolver collapsed `..` but never percent-decoded; the XLSX sheet
 * resolver did neither. These pin the decode, the fragment strip, and the `.`/`..`
 * collapse for the EPUB, PPTX, and XLSX shapes so all three share one correct path.
 */

describe("resolveArchiveMemberPath — EPUB hrefs", () => {
	it("joins an href under the OPF directory", () => {
		expect(resolveArchiveMemberPath("OEBPS", "text/ch1.xhtml")).toBe("OEBPS/text/ch1.xhtml");
	});

	it("returns the href unchanged when the OPF is at the zip root", () => {
		expect(resolveArchiveMemberPath("", "ch1.xhtml")).toBe("ch1.xhtml");
	});

	it("collapses a single parent-directory segment", () => {
		expect(resolveArchiveMemberPath("OEBPS", "../images/x.html")).toBe("images/x.html");
	});

	it("collapses multiple parent-directory segments", () => {
		expect(resolveArchiveMemberPath("OEBPS/sub", "../../root.html")).toBe("root.html");
	});

	it("drops a leading current-directory segment", () => {
		expect(resolveArchiveMemberPath("OEBPS", "./ch1.xhtml")).toBe("OEBPS/ch1.xhtml");
	});

	it("strips a URI fragment before resolving", () => {
		expect(resolveArchiveMemberPath("OEBPS", "ch1.xhtml#part2")).toBe("OEBPS/ch1.xhtml");
	});

	it("percent-decodes the href", () => {
		expect(resolveArchiveMemberPath("OEBPS", "ch%201.xhtml")).toBe("OEBPS/ch 1.xhtml");
	});

	it("resolves an absolute href from the zip root, ignoring baseDir", () => {
		expect(resolveArchiveMemberPath("OEBPS", "/ch1.xhtml")).toBe("ch1.xhtml");
	});

	it("clamps a '..' that would escape the zip root", () => {
		expect(resolveArchiveMemberPath("", "../x.html")).toBe("x.html");
	});

	it("handles a combined parent, percent-encoding, and fragment href", () => {
		expect(resolveArchiveMemberPath("OEBPS", "../Text/ch%201.xhtml#frag")).toBe("Text/ch 1.xhtml");
	});

	it("leaves a malformed percent-escape as-is instead of throwing", () => {
		expect(resolveArchiveMemberPath("OEBPS", "ch%zz.xhtml")).toBe("OEBPS/ch%zz.xhtml");
	});
});

describe("resolveArchiveMemberPath — PPTX image rel Targets", () => {
	it("resolves a '../media' slide-relative target to the media directory", () => {
		// The historical PPTX case: slide rels live in ppt/slides/_rels, so the
		// image target is written relative to ppt/slides and must climb one level.
		expect(resolveArchiveMemberPath("ppt/slides", "../media/image1.png")).toBe("ppt/media/image1.png");
	});

	it("percent-decodes a media target with a space (the gap the old inline resolver missed)", () => {
		expect(resolveArchiveMemberPath("ppt/slides", "../media/my%20image.png")).toBe("ppt/media/my image.png");
	});

	it("resolves an absolute media target from the zip root", () => {
		expect(resolveArchiveMemberPath("ppt/slides", "/ppt/media/image2.png")).toBe("ppt/media/image2.png");
	});
});

describe("resolveArchiveMemberPath — XLSX sheet rel Targets", () => {
	it("resolves a worksheet target relative to xl/", () => {
		expect(resolveArchiveMemberPath("xl", "worksheets/sheet1.xml")).toBe("xl/worksheets/sheet1.xml");
	});

	it("percent-decodes a worksheet target (the gap the old inline resolver missed)", () => {
		expect(resolveArchiveMemberPath("xl", "worksheets/sheet%201.xml")).toBe("xl/worksheets/sheet 1.xml");
	});

	it("collapses a '..' worksheet target (the case the old inline join never normalized)", () => {
		expect(resolveArchiveMemberPath("xl", "../xl/worksheets/sheet1.xml")).toBe("xl/worksheets/sheet1.xml");
	});

	it("resolves an absolute worksheet target from the zip root", () => {
		expect(resolveArchiveMemberPath("xl", "/xl/worksheets/sheet1.xml")).toBe("xl/worksheets/sheet1.xml");
	});
});
