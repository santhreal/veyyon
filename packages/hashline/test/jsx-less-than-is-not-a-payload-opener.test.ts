/**
 * `payloadHasJsxOpenerForEcho` walks the payload with `isJsxTagStart`, which
 * treats `<` followed by a letter as a tag. That is also every TypeScript
 * generic (`Foo<Bar>`) and every comparison whose right-hand side starts
 * with an identifier (`a < b`). If the scanner promotes those to openers,
 * a one-sided `</section>` echo is treated as a nested closer of a tag that
 * was never opened, and the repair that should drop the restated closer
 * refuses to — leaving a duplicated `</section>` in the file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(src: string, patch: string) {
	return applyEdits(src, parsePatch(patch).edits);
}

describe("a comparison or generic is not a JSX opener for a trailing closer echo", () => {
	it("still drops a restated </section> when the new body compares a < b", () => {
		const file = [
			"export function Box() {",
			"  return (",
			"    <section>",
			"      {value}",
			"    </section>",
			"  );",
			"}",
		].join("\n");
		const { text } = apply(
			file,
			["SWAP 4.=4:", "+      {a < b ? value : 0}", "+    </section>"].join("\n"),
		);
		expect(text.split("\n").filter(line => line.trim() === "</section>")).toHaveLength(1);
		expect(text).toContain("{a < b ? value : 0}");
	});

	it("still drops a restated </Foo> when the payload names a generic Foo<Bar>", () => {
		const file = [
			"function render(x: Foo<Bar>) {",
			"  return (",
			"    <Foo>",
			"      {x}",
			"    </Foo>",
			"  );",
			"}",
		].join("\n");
		const { text } = apply(file, ["SWAP 4.=4:", "+      {x as Foo<Bar>}", "+    </Foo>"].join("\n"));
		expect(text.split("\n").filter(line => line.trim() === "</Foo>")).toHaveLength(1);
		expect(text).toContain("x as Foo<Bar>");
	});
});
