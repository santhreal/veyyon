import { processFileArguments } from "@veyyon/coding-agent/cli/file-processor";

const stream = "BT /F1 24 Tf 72 720 Td (Hello PDF from issue 1401) Tj ET";
let pdf = "%PDF-1.4\n";
const offsets = [0];
const add = (body: string): void => {
	offsets.push(Buffer.byteLength(pdf));
	pdf += `${offsets.length - 1} 0 obj\n${body}\nendobj\n`;
};
add("<< /Type /Catalog /Pages 2 0 R >>");
add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>");
add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
const xref = Buffer.byteLength(pdf);
pdf += "xref\n0 6\n0000000000 65535 f \n";
for (let index = 1; index <= 5; index++) pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const file = `/tmp/veyyon-pdf-runtime-${process.pid}.pdf`;
await Bun.write(file, pdf);
try {
	const result = await processFileArguments([file], { autoResizeImages: false });
	if (!result.text.includes("Hello PDF from issue 1401")) throw new Error(result.text);
	process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
	await Bun.file(file).delete();
}
