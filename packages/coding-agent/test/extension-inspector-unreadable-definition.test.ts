/**
 * The extension inspector has to say WHY it could not read a definition.
 *
 * Three sections of the panel parse whatever an extension provider handed them: a
 * tool's parameter schema, a skill's instruction text, an MCP server's connection
 * block. Each wrapped that work in a `catch` that printed a dim
 * `(unable to parse …)` with no reason and no log line. Dim is the colour this
 * panel uses for "there is nothing here" — `(no arguments)`, `(no content)` — so a
 * malformed tool definition looked like a tool that simply declares no arguments,
 * and there was nowhere to look for the cause.
 *
 * These tests drive the panel through its public `render` with a definition built
 * to throw during parsing, and assert the reason reaches the screen. The reason is
 * the whole point: a notice that only says "unable" leaves the operator with the
 * same nothing they had before.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { InspectorPanel } from "@veyyon/coding-agent/modes/components/extensions/inspector-panel";
import type { Extension, ExtensionKind } from "@veyyon/coding-agent/modes/components/extensions/types";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

const WIDTH = 120;

beforeAll(async () => {
	await initTheme();
});

function extension(kind: ExtensionKind, raw: unknown): Extension {
	return {
		id: `${kind}:probe`,
		kind,
		name: "probe",
		displayName: "probe",
		path: "/tmp/probe.ts",
		source: { provider: "test", providerName: "test", level: "user" },
		state: "active",
		raw,
	} as Extension;
}

/** Rendered panel with styling removed and wrapped rows re-joined. */
function panelText(ext: Extension): string {
	const panel = new InspectorPanel();
	panel.setExtension(ext);
	return panel
		.render(WIDTH)
		.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * A definition whose access throws mid-parse. A getter is how this actually
 * happens in the wild: a lazily-evaluated schema, a proxy over a config object, a
 * zod refinement that runs on read.
 */
function throwingOn(property: string, message: string): Record<string, unknown> {
	return Object.defineProperty({}, property, {
		get() {
			throw new Error(message);
		},
		enumerable: true,
	});
}

describe("a tool definition that cannot be read", () => {
	it("names the reason instead of only saying it failed", () => {
		const text = panelText(extension("tool", throwingOn("parameters", "schema is not a zod object")));

		expect(text).toContain("unable to read the tool definition");
		expect(text).toContain("schema is not a zod object");
	});

	/** The old wording claimed a parse failure, but the section reads a definition
	 * that may never have been parsed at all — the getter above throws on access. */
	it("does not claim the definition failed to parse", () => {
		const text = panelText(extension("tool", throwingOn("parameters", "boom")));

		expect(text).not.toContain("unable to parse");
	});

	/** "No arguments" is the panel's dim empty state. A broken definition must not
	 * be mistaken for one, which is what the dim colour used to invite. */
	it("is not rendered as the empty state", () => {
		const text = panelText(extension("tool", throwingOn("parameters", "boom")));

		expect(text).not.toContain("(no arguments)");
	});

	it("still shows the rest of the panel around it", () => {
		const text = panelText(extension("tool", throwingOn("parameters", "boom")));

		expect(text).toContain("probe");
		expect(text).toContain("Status:");
	});
});

describe("a skill whose content cannot be read", () => {
	it("names the reason", () => {
		const text = panelText(extension("skill", throwingOn("prompt", "frontmatter is truncated")));

		expect(text).toContain("unable to read the skill content");
		expect(text).toContain("frontmatter is truncated");
	});

	it("is not rendered as the empty state", () => {
		const text = panelText(extension("skill", throwingOn("prompt", "boom")));

		expect(text).not.toContain("(no instruction text)");
	});
});

describe("an MCP configuration that cannot be read", () => {
	it("names the reason", () => {
		const text = panelText(extension("mcp", throwingOn("transport", "env block is not an object")));

		expect(text).toContain("unable to read the MCP configuration");
		expect(text).toContain("env block is not an object");
	});
});

describe("a definition that reads cleanly", () => {
	/** The notice must cost nothing when nothing is wrong. */
	it("shows the section with no notice", () => {
		const text = panelText(extension("mcp", { transport: "stdio", command: "mcp-server", args: ["--port", "1"] }));

		expect(text).toContain("stdio");
		expect(text).toContain("mcp-server");
		expect(text).not.toContain("unable to read");
	});
});
