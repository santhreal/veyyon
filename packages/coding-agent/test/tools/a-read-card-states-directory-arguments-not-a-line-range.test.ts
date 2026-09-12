/**
 * WHY THIS SUITE EXISTS:
 *
 * `read { path: ".", limit: 3 }` drew the card `.:1-3`. `parseReadArgs` still modelled a legacy
 * `offset`/`limit` line window, while the schema had redefined `limit` as the directory entry cap
 * and dropped `offset`, so the card described a line range the tool never read.
 *
 * CLASS: a read card describing a schema argument as something the schema does not say it is.
 * The numeric arguments are enumerated from the read tool's own schema at run time, so a new one
 * fails here until the card states it by name: the card must print `<name> <value>` for each and
 * must never print a `:N` / `:N-M` suffix that did not come from the path's own selector.
 *
 * DOES NOT CATCH: a wrong selector on the path itself (`read-renderer.test.ts` pins that the
 * selector is echoed and linked), or the HTML export's own call formatter.
 */
import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { readToolView } from "@veyyon/coding-agent/tools/fs/read-view";
import { isRecord } from "@veyyon/utils/type-guards";
import type { StatusRowView, ToolView } from "@veyyon/view";
import { makeToolSession } from "../helpers/tool-session";

const CONTEXT = { expanded: false, partial: false } as const;

function headerOf(view: ToolView): StatusRowView {
	if (view.kind === "statusRow") return view;
	if (view.kind === "framedBlock" && view.header !== undefined) return view.header;
	throw new Error(`unexpected view kind ${view.kind}`);
}

/** The read schema's non-path arguments, read off the shipped tool so a new one is swept. */
function schemaArgumentNames(): string[] {
	const tool = new ReadTool(makeToolSession({ settings: Settings.isolated() }));
	const json: unknown = tool.parameters.toJsonSchema();
	if (!isRecord(json) || !isRecord(json.properties)) throw new Error("read schema has no properties");
	return Object.keys(json.properties).filter(name => name !== "path");
}

describe("a read card states directory arguments, not a line range", () => {
	const names = schemaArgumentNames();

	it("sweeps the schema's non-path arguments, pinned so a new one is a decision here", () => {
		expect(names).toEqual(["depth", "limit"]);
	});

	for (const name of names) {
		it(`${name}: the pending and settled cards print "${name} 3" and no :N-M suffix`, () => {
			const args = { path: ".", [name]: 3 };
			const pending = headerOf(readToolView.renderCall(args, CONTEXT));
			const settled = headerOf(
				readToolView.renderResult(
					{ content: [{ type: "text", text: "a\nb\nc" }], details: { isDirectory: true, resolvedPath: "/repo" } },
					CONTEXT,
					args,
				),
			);
			for (const header of [pending, settled]) {
				expect(header.description).toBe(`. (${name} 3)`);
				expect(header.description).not.toMatch(/:\d+(?:-\d+)?/);
				// No line to open the directory at: the argument is not a line.
				expect(header.descriptionFileLine).toBeUndefined();
			}
		});
	}

	it("states every argument the call passed, in schema order, after the path", () => {
		const args = { path: ".", ...Object.fromEntries(names.map((name, i) => [name, i + 2])) };
		const header = headerOf(readToolView.renderCall(args, CONTEXT));
		expect(header.description).toBe(`. (${names.map((name, i) => `${name} ${i + 2}`).join(", ")})`);
	});

	it("keeps the path's own selector and adds nothing for a call with no arguments", () => {
		expect(headerOf(readToolView.renderCall({ path: "src/app.ts:10-20" }, CONTEXT)).description).toBe(
			"src/app.ts:10-20",
		);
		expect(headerOf(readToolView.renderCall({ path: "." }, CONTEXT)).description).toBe(".");
	});
});
