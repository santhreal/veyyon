import { convertBufferWithMarkit } from "@veyyon/coding-agent/utils/markit";
import { setTransports } from "@veyyon/utils/logger";

function warningPdf(): Uint8Array {
	const objects: string[] = [];
	const pageText = "/P <</MCID 0>> BDC\nBT /F1 24 Tf 72 720 Td (Tagged PDF repro text) Tj ET\nEMC\n";
	objects.push("<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 8 0 R >>");
	objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
	objects.push(
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /StructParents 0 /Annots [9 0 R] >>",
	);
	objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	objects.push(`<< /Length ${pageText.length} >>\nstream\n${pageText}endstream`);
	objects.push("<< /Nums [0 [7 0 R]] >>");
	objects.push("<< /Type /StructElem /S /P /P 8 0 R /Pg 3 0 R /K 99 >>");
	objects.push("<< /Type /StructTreeRoot /K [7 0 R] /ParentTree 6 0 R /ParentTreeNextKey 1 >>");
	objects.push("<< /Type /Annot /Subtype /Screen /Rect [72 650 200 700] /T (movie) >>");
	let pdf = "%PDF-1.7\n";
	const offsets = [0];
	for (let index = 0; index < objects.length; index++) {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
	}
	const xref = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (let index = 1; index < offsets.length; index++) {
		pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
	}
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(pdf);
}

setTransports({ console: true, file: false });
const capturedConsoleErrors: unknown[][] = [];
console.error = (...values: unknown[]) => {
	capturedConsoleErrors.push(values);
};
const result = await convertBufferWithMarkit(warningPdf(), ".pdf", undefined, { useCache: false });
process.stdout.write(`__VEYYON_RESULT__${JSON.stringify({ result, capturedConsoleErrors })}\n`);
