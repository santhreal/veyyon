import { describe, expect, it } from "bun:test";
import { type CompanyData, renderCompanyInfoTable } from "@veyyon/coding-agent/web/scrapers/opencorporates";

/**
 * Locks the opencorporates arm of the markdown-table cell-escaping bug class.
 * The basic-info table interpolated external registry free-text — a company's
 * `current_status`, `company_type`, `branch`, and even its `company_number` and
 * dates — straight into a `| Field | Value |` row. A `|` in any of those (a
 * status like "In Liquidation | Court Order", a pipe-bearing branch note, an
 * exotic registry id) or a newline ended the two-column row early and pushed the
 * value out from under the Value header. renderCompanyInfoTable now routes every
 * value cell through the canonical escapeMarkdownTableCell. These assert the exact
 * cell bytes and that each data row keeps exactly two columns, so a revert to raw
 * interpolation fails loudly.
 */
describe("renderCompanyInfoTable value-cell escaping", () => {
	const company = (over: Partial<CompanyData>): CompanyData => ({
		name: "Acme Corp",
		company_number: "12345",
		jurisdiction_code: "us_de",
		...over,
	});

	// Split a rendered row on unescaped pipes: a well-formed two-column row is
	// `| a | b |`, which yields 4 segments (leading + trailing empty + 2 cells).
	const columns = (row: string): number => row.split(/(?<!\\)\|/).length;

	// The data rows follow the header line and the `---` separator line.
	const dataRows = (md: string): string[] => md.split("\n").filter(Boolean).slice(2);

	it("escapes a pipe in the free-text status so the row keeps two columns", () => {
		const rows = dataRows(renderCompanyInfoTable(company({ current_status: "In Liquidation | Court Order" })));
		const statusRow = rows.find(r => r.includes("Status"));
		expect(statusRow).toBe("| **Status** | In Liquidation \\| Court Order |");
		expect(columns(statusRow as string)).toBe(4);
	});

	it("escapes a pipe in the company type", () => {
		const rows = dataRows(renderCompanyInfoTable(company({ company_type: "Trust | Foundation" })));
		const typeRow = rows.find(r => r.includes("Company Type"));
		expect(typeRow).toBe("| **Company Type** | Trust \\| Foundation |");
	});

	it("collapses a newline in a branch value so it cannot end the row early", () => {
		const rows = dataRows(renderCompanyInfoTable(company({ branch: "London\nOffice", branch_status: "active" })));
		const branchRow = rows.find(r => r.includes("Branch"));
		expect(branchRow).toBe("| **Branch** | London Office (active) |");
		expect(branchRow).not.toContain("\n");
	});

	it("escapes a pipe in an exotic company number", () => {
		const rows = dataRows(renderCompanyInfoTable(company({ company_number: "A|B|123" })));
		expect(rows[0]).toBe("| **Company Number** | A\\|B\\|123 |");
		expect(columns(rows[0])).toBe(4);
	});

	it("keeps the static Field column and header intact for a plain company", () => {
		const md = renderCompanyInfoTable(company({ current_status: "Active", company_type: "Private Limited" }));
		const lines = md.split("\n").filter(Boolean);
		expect(lines[0]).toBe("| Field | Value |");
		expect(lines[1]).toBe("|-------|-------|");
		expect(lines).toContain("| **Status** | Active |");
		expect(lines).toContain("| **Company Type** | Private Limited |");
	});

	it("omits the native-number row when it duplicates the company number", () => {
		const md = renderCompanyInfoTable(company({ company_number: "999", native_company_number: "999" }));
		expect(md).not.toContain("Native Number");
	});
});
