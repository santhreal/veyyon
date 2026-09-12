/**
 * WHY: Symbol positions must render resolved glyphs as text, a key with no glyph must draw nothing
 * rather than the key, and compact headers must omit only the complete repeated tool label. This
 * exercises React's DOM output, including inherited property names and markup-like symbols; it does
 * not verify terminal rendering, CSS geometry, or live pointer interaction.
 */

import { describe, expect, it } from "bun:test";
import type { ToolView as CanonicalToolView, StatusRowView } from "@veyyon/view";
import type { ToolExecutionDisplay } from "@veyyon/wire/presentation";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolView } from "../src/ToolView";
import type { ToolRenderHost } from "../src/types";
import {
	CanonicalViewRenderer,
	StatusRowViewComponent,
	ToolExecutionBody,
	ToolExecutionSummary,
} from "../src/ViewRenderer";
import { CANONICAL_SYMBOLS, safeHref } from "../src/view-core";

describe("ToolView and Canonical View DOM integration", () => {
	it.each(Object.entries(CANONICAL_SYMBOLS).filter(([, glyph]) => glyph !== ""))(
		"renders symbol %s as its glyph across symbol positions",
		(symbol, glyph) => {
			const views: CanonicalToolView[] = [
				{ kind: "textBlock", spans: [{ text: "", symbol }] },
				{ kind: "statusRow", title: "Operation", emblem: symbol },
				{ kind: "notice", state: "warning", headline: [{ text: "Operation" }], mark: symbol },
			];
			for (const view of views) {
				const html = renderToStaticMarkup(createElement(CanonicalViewRenderer, { view }));
				const { document } = parseHTML(`<html><body>${html}</body></html>`);
				expect(document.body.textContent).toContain(glyph);
				expect(document.body.textContent).not.toContain(symbol);
				expect(document.querySelector("em")).toBeNull();
			}
		},
	);

	it.each(["<em>literal</em>", "constructor", "__proto__", "hint.tip"])(
		"draws the span text and never the key for unknown symbol %s",
		symbol => {
			const views: CanonicalToolView[] = [
				{ kind: "textBlock", spans: [{ text: "fallback", symbol }] },
				{ kind: "statusRow", title: "Operation", emblem: symbol },
				{ kind: "notice", state: "warning", headline: [{ text: "Operation" }], mark: symbol },
			];
			for (const view of views) {
				const html = renderToStaticMarkup(createElement(CanonicalViewRenderer, { view }));
				const { document } = parseHTML(`<html><body>${html}</body></html>`);
				expect(document.body.textContent).not.toContain(symbol);
				expect(document.querySelector("em")).toBeNull();
			}
			const span = renderToStaticMarkup(
				createElement(CanonicalViewRenderer, {
					view: { kind: "textBlock", spans: [{ text: "fallback", symbol }] },
				}),
			);
			expect(parseHTML(`<html><body>${span}</body></html>`).document.body.textContent).toContain("fallback");
		},
	);

	it.each([
		{ label: "launch", title: "Launch start", summary: "start" },
		{ label: "read", title: "Read", summary: "" },
		{ label: "read", title: "Readonly summary", summary: "Readonly summary" },
		{ label: "custom", title: "Read", summary: "Read" },
	])("avoids duplicate $label labels while preserving $title details", ({ label, title, summary }) => {
		const header: StatusRowView = { kind: "statusRow", title, description: "src/example.ts" };
		const views: CanonicalToolView[] = [
			header,
			{ kind: "headedBlock", header, lines: [] },
			{ kind: "framedBlock", header, sections: [] },
		];
		for (const view of views) {
			const html = renderToStaticMarkup(
				createElement(ToolView, {
					name: label,
					display: { toolLabel: label, callView: view },
				}),
			);
			const { document } = parseHTML(`<html><body>${html}</body></html>`);
			expect(Array.from(document.querySelectorAll(".tv-head .tv-name"), node => node.textContent)).toEqual(
				summary ? [label, summary] : [label],
			);
			expect(document.querySelector(".tv-sum")?.textContent).toContain("src/example.ts");
		}
		const standalone = renderToStaticMarkup(createElement(StatusRowViewComponent, { view: header, inline: true }));
		const { document } = parseHTML(`<html><body>${standalone}</body></html>`);
		expect(document.querySelector(".tv-name")?.textContent).toBe(title);
	});

	it("renders all canonical view union variants", () => {
		const statusRow: CanonicalToolView = {
			kind: "statusRow",
			status: "success",
			title: "Operation Complete",
			description: "src/main.ts",
			badge: { label: "v2.0", tone: "accent" },
		};
		const srHtml = renderToStaticMarkup(createElement(CanonicalViewRenderer, { view: statusRow }));
		expect(srHtml).toContain("Operation Complete");
		expect(srHtml).toContain("src/main.ts");
		expect(srHtml).toContain("v2.0");

		const textBlock: CanonicalToolView = {
			kind: "textBlock",
			spans: [
				{ text: "Bold Text", bold: true },
				{ text: "Italic Text", italic: true },
				{ text: "Strike Text", strike: true },
				{ text: "Code Text", captured: true },
			],
		};
		const tbHtml = renderToStaticMarkup(createElement(CanonicalViewRenderer, { view: textBlock }));
		expect(tbHtml).toContain("<strong>Bold Text</strong>");
		expect(tbHtml).toContain("<em>Italic Text</em>");
		expect(tbHtml).toContain("<s>Strike Text</s>");
		expect(tbHtml).toContain("<code>Code Text</code>");

		const headedBlock: CanonicalToolView = {
			kind: "headedBlock",
			header: {
				kind: "statusRow",
				status: "info",
				title: "Headed Section",
			},
			lines: [[{ text: "First line of headed block" }], [{ text: "Second line of headed block" }]],
		};
		const hbHtml = renderToStaticMarkup(createElement(CanonicalViewRenderer, { view: headedBlock }));
		expect(hbHtml).toContain("Headed Section");
		expect(hbHtml).toContain("First line of headed block");
		expect(hbHtml).toContain("Second line of headed block");

		const framedBlock: CanonicalToolView = {
			kind: "framedBlock",
			state: "success",
			header: {
				kind: "statusRow",
				status: "success",
				title: "Framed Section",
			},
			sections: [
				{
					label: "Diff section",
					lines: [[{ text: "+added line" }], [{ text: "-removed line" }]],
					diff: {
						sides: ["added", "removed"],
					},
				},
				{
					label: "Code section",
					lines: [[{ text: "const x = 1;" }]],
					code: {
						language: "typescript",
						firstLineNumber: 1,
					},
				},
			],
		};
		const fbHtml = renderToStaticMarkup(createElement(CanonicalViewRenderer, { view: framedBlock }));
		expect(fbHtml).toContain("Framed Section");
		expect(fbHtml).toContain("Diff section");
		expect(fbHtml).toContain("+added line");
		expect(fbHtml).toContain("const x = 1;");

		const notice: CanonicalToolView = {
			kind: "notice",
			state: "warning",
			headline: [{ text: "Warning Headline" }],
			tag: "important",
			body: [[{ text: "Detailed warning explanation" }]],
		};
		const nHtml = renderToStaticMarkup(createElement(CanonicalViewRenderer, { view: notice }));
		expect(nHtml).toContain("Warning Headline");
		expect(nHtml).toContain("important");
		expect(nHtml).toContain("Detailed warning explanation");
		expect(nHtml).toContain("tv-note--warn");
	});

	it("sanitizes unsafe link schemes and permits safe protocols", () => {
		expect(safeHref("https://example.com/docs")).toBe("https://example.com/docs");
		expect(safeHref("http://localhost:3000")).toBe("http://localhost:3000");
		expect(safeHref("mailto:dev@example.com")).toBe("mailto:dev@example.com");
		expect(safeHref("file:///workspace/repo/README.md")).toBe("file:///workspace/repo/README.md");

		expect(safeHref("javascript:alert(1)")).toBeNull();
		expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeNull();
		expect(safeHref("vbscript:msgbox(1)")).toBeNull();
		expect(safeHref("   ")).toBeNull();
		expect(safeHref(undefined)).toBeNull();
	});

	it("renders agent actions via AgentLink when host capability is provided", () => {
		const host: ToolRenderHost = {
			hasAgent: id => id === "subagent-1",
			openAgent: () => {},
		};

		const textWithAgent: CanonicalToolView = {
			kind: "textBlock",
			spans: [{ text: "Subagent Task", agentId: "subagent-1" }],
		};

		const html = renderToStaticMarkup(createElement(CanonicalViewRenderer, { view: textWithAgent, host }));
		expect(html).toContain("tv-agent-link");
		expect(html).toContain("Subagent Task");
	});

	it("renders running and streaming partial states", () => {
		const html = renderToStaticMarkup(
			createElement(ToolView, {
				name: "bash",
				args: { command: "long-running-job" },
				running: true,
				partial: "building target 1...\nbuilding target 2...",
				defaultOpen: true,
			}),
		);

		expect(html).toContain('aria-label="running"');
		expect(html).toContain("building target 1");
		expect(html).toContain("building target 2");
	});

	it("renders multi-file and read-entry summaries", () => {
		const display: ToolExecutionDisplay = {
			readEntry: {
				toolCallId: "read-example",
				path: "src/index.ts",
				conflictCount: 3,
				status: "warning",
				contentText: "console.log('hello')",
			},
			multiFileViews: [
				{
					path: "packages/a/src/lib.ts",
					view: {
						kind: "statusRow",
						status: "success",
						title: "Modified",
					},
				},
				{
					path: "packages/b/src/lib.ts",
					errorNotice: "File permission denied",
					isError: true,
				},
			],
		};

		const summaryHtml = renderToStaticMarkup(
			createElement(ToolExecutionSummary, { name: "read", args: {}, display }),
		);
		expect(summaryHtml).toContain("src/index.ts");
		expect(summaryHtml).toContain("3 conflicts");

		const bodyHtml = renderToStaticMarkup(createElement(ToolExecutionBody, { name: "read", args: {}, display }));
		expect(bodyHtml).toContain("packages/a/src/lib.ts");
		expect(bodyHtml).toContain("packages/b/src/lib.ts");
		expect(bodyHtml).toContain("File permission denied");
		expect(bodyHtml).toContain("console.log(&#x27;hello&#x27;)");
	});

	it("renders result images with click-to-open interaction", () => {
		const display: ToolExecutionDisplay = {
			images: [
				{
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					mimeType: "image/png",
				},
			],
		};

		const html = renderToStaticMarkup(
			createElement(ToolExecutionBody, { name: "generate_image", args: {}, display }),
		);
		expect(html).toContain("<img ");
		expect(html).toContain("data:image/png;base64,");
		expect(html).toContain("Open tool result image 1");
	});

	it("falls back to generic JSON when no display projection is supplied", () => {
		const html = renderToStaticMarkup(
			createElement(ToolView, {
				name: "custom_third_party_tool",
				args: { foo: "bar", count: 42 },
				result: {
					content: [{ type: "text", text: "Custom tool output text" }],
				},
				defaultOpen: true,
			}),
		);

		expect(html).toContain("custom_third_party_tool");
		expect(html).toContain("foo");
		expect(html).toContain("bar");
		expect(html).toContain("Custom tool output text");
	});
});
