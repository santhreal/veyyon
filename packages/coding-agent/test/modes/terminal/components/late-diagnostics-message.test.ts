/**
 * Late diagnostics preserve grouped severity, location, disclosure and indentation
 * while applying terminal text sanitization to every displayed field. These tests
 * do not exercise LSP transport or delivery timing.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { stripVTControlCharacters } from "node:util";
import { LateDiagnosticsMessageComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/late-diagnostics-message";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/theme/theme";

const darkTheme = await getThemeByName("dark");

function plain(component: LateDiagnosticsMessageComponent): string {
	return stripVTControlCharacters(component.render(120).join("\n"));
}

describe("LateDiagnosticsMessageComponent", () => {
	beforeEach(() => {
		if (!darkTheme) throw new Error("Failed to load dark theme");
		setThemeInstance(darkTheme);
	});

	it("groups files and renders parsed diagnostic locations", () => {
		const component = new LateDiagnosticsMessageComponent([
			{
				path: "/abs/packages/coding-agent/src/foo.ts",
				summary: "1 error(s)",
				errored: true,
				messages: [
					"packages/coding-agent/src/foo.ts:7804:14 [error] [typescript] Type 'string' is not assignable to type 'number'. (2322)",
				],
			},
		]);

		const text = plain(component);
		expect(text).toContain("Late diagnostics");
		expect(text).toContain("1 error(s)");
		// File grouped as its own tree node...
		expect(text).toContain("packages/coding-agent/src/foo.ts");
		// ...and the diagnostic on a separate row with parsed location + message.
		expect(text).toContain(":7804:14");
		expect(text).toContain("Type 'string' is not assignable to type 'number'.");
		// The shared renderer folds severity/source into icons, so the raw inline
		// `[error]`/`[typescript]` markers of the old flat format must be gone.
		expect(text).not.toContain("[error]");
		expect(text).not.toContain("[typescript]");
		expect(text).not.toMatch(/[├└│]/);
	});

	it("caps collapsed output and reveals the rest when expanded", () => {
		const messages = Array.from(
			{ length: 8 },
			(_, i) => `src/foo.ts:${i + 1}:1 [error] [typescript] err ${i + 1} (2322)`,
		);
		const component = new LateDiagnosticsMessageComponent([
			{ path: "/abs/src/foo.ts", summary: "8 error(s)", errored: true, messages },
		]);

		const collapsed = plain(component);
		expect(collapsed).toContain("err 1");
		expect(collapsed).not.toContain("err 8");
		expect(collapsed).toContain("… 3 more");
		expect(collapsed).not.toMatch(/[├└│]/);

		component.setExpanded(true);
		const expanded = plain(component);
		expect(expanded).toContain("err 8");
		expect(expanded).not.toContain("more");
	});

	it("groups multiple files under a single header", () => {
		const component = new LateDiagnosticsMessageComponent([
			{
				path: "/abs/a.ts",
				summary: "1 error(s), 1 warning(s)",
				errored: true,
				messages: [
					"a.ts:20:1 [warning] [typescript] unused a (6133)",
					"a.ts:10:5 [error] [typescript] bad a (2322)",
				],
			},
			{
				path: "/abs/b.ts",
				summary: "1 warning(s)",
				errored: false,
				messages: ["b.ts:2:2 [warning] [typescript] bad b (2322)"],
			},
		]);

		const text = plain(component);
		expect(text.match(/Late diagnostics/g)?.length).toBe(1);
		expect(text).toContain("a.ts");
		expect(text).toContain("b.ts");
		expect(text).toContain("bad a");
		expect(text).toContain("bad b");
		const lines = text.split("\n");
		const a = lines.findIndex(line => line.includes("a.ts"));
		const b = lines.findIndex(line => line.includes("b.ts"));
		expect(lines[a + 1]).toMatch(/^\s{3}\S.*:10:5/);
		expect(lines[a + 2]).toMatch(/^\s{3}\S.*:20:1/);
		expect(b).toBeGreaterThan(a + 2);
		expect(lines[b + 1]).toMatch(/^\s{3}\S.*:2:2/);
		expect(text).not.toMatch(/[├└│]/);
	});

	it("expands tabs in summaries, parsed diagnostics and unmatched lines", () => {
		const component = new LateDiagnosticsMessageComponent([
			{
				errored: true,
				summary: "1\terror(s)",
				messages: [
					"src/example.go:183:41 [error] [compiler] too many\targuments in call (WrongArgCount)",
					"\tunparsed diagnostic\tmessage",
				],
			},
		]);
		component.setExpanded(true);
		const text = plain(component);
		expect(text).not.toContain("\t");
		const normalized = text.replace(/\s+/g, " ");
		expect(normalized).toContain("too many arguments in call");
		expect(normalized).toContain("unparsed diagnostic message");
		expect(normalized).toContain("1 error(s)");
	});

	it("shortens home paths across every displayed diagnostic field", () => {
		const home = os.homedir();
		const component = new LateDiagnosticsMessageComponent([
			{
				errored: true,
				summary: `${home}/summary`,
				messages: [
					`${home}/src/app.ts:1:2 [error] [compiler] ${home}/detail (${home}/code)`,
					`unparsed ${home}/output`,
				],
			},
		]);
		const text = plain(component);
		expect(text).not.toContain(home);
		for (const suffix of ["summary", "src/app.ts", "detail", "code", "output"]) {
			expect(text).toContain(`~/${suffix}`);
		}
	});

	it("renders nothing when no diagnostics are present", () => {
		const component = new LateDiagnosticsMessageComponent([
			{ path: "/abs/empty.ts", summary: "", errored: false, messages: [] },
		]);
		expect(plain(component).trim()).toBe("");
	});
});
