import { describe, expect, it } from "bun:test";
import { APPROVAL_DIALOG_OPTIONS, APPROVAL_SELECT_OPTIONS } from "../src/extensibility/extensions/wrapper";
import { formatApprovalCard } from "../src/tools/approval";

describe("interactive permission card presentation", () => {
	/** A routine prompt must state its one-call scope before the operator chooses. */
	it("states tool identity and one-call scope without inventing persistent approval", () => {
		expect(formatApprovalCard({ name: "bash" }, {})).toBe(
			"## Permission required\n**Tool:** `bash`\n**Scope:** This call only",
		);
		expect(APPROVAL_SELECT_OPTIONS).toEqual([
			{ label: "Approve", description: "Run this call once. No policy is saved." },
			{ label: "Deny", description: "Do not run this call." },
		]);
	});

	/** The dangerous reason and requested command must remain distinct visual sections. */
	it("separates the approval reason from requested action details", () => {
		expect(
			formatApprovalCard(
				{ name: "bash", formatApprovalDetails: () => ["Command: rm -rf /tmp/x", "Working directory: ~/repo"] },
				{},
				"Recursive delete targets a protected path.",
			),
		).toBe(
			"## Permission required\n" +
				"**Tool:** `bash`\n" +
				"**Scope:** This call only\n" +
				"**Reason:** Recursive delete targets a protected path.\n\n" +
				"**Requested action**\n" +
				"Command: rm -rf /tmp/x\n" +
				"Working directory: ~/repo",
		);
	});

	/** MCP requests must retain their untrusted external origin in the card hierarchy. */
	it("identifies MCP-origin tools before their reason and details", () => {
		expect(
			formatApprovalCard(
				{ name: "mcp__billing__refund", formatApprovalDetails: () => "Invoice: 42" },
				{},
				"Changes billing state.",
			),
		).toContain(
			"**Origin:** MCP server tool\n**Reason:** Changes billing state.\n\n**Requested action**\nInvoice: 42",
		);
	});

	/** The selector must expose focus and complete navigation help on every prompt. */
	it("uses radio focus and explicit confirm and cancel help", () => {
		expect(APPROVAL_DIALOG_OPTIONS).toEqual({
			selectionMarker: "radio",
			helpText: "↑/↓ navigate  enter confirm  esc cancel",
		});
	});
});
