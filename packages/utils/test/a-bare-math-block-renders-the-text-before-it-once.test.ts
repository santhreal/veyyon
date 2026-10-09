/**
 * A bare `\begin{env}…\end{env}` math block pulls a math-shaped lead-in into its
 * rendering: the text before it on its line when that text holds `\` or `=`,
 * or the previous line when that line ends in `=`, `(`, `[` or `{`. The scan
 * had already emitted the text before its position, so a lead-in reaching back
 * past it rendered that text a second time: `\begin{matrix}a\end{matrix} =
 * \begin{matrix}b\end{matrix}` printed `aa = b`. The class this suite closes:
 * every way the scan moves past text (a rendered math block, a verbatim
 * non-math block, an unterminated `\begin`) followed by every way a block's
 * lead-in reaches back renders each source character once, in order.
 *
 * Not caught: a lead-in rule added to the scanner beyond the two above; the
 * reach-back shapes are listed here because the scanner exports no table of
 * them.
 */
import { describe, expect, it } from "bun:test";
import { renderMathInText } from "@veyyon/utils/latex-unicode";

/** Text the scan moves past before the next block; each holds the marker `7`. */
const PREDECESSORS: Record<string, string> = {
	"a rendered math block": "\\begin{matrix}7\\end{matrix}",
	"a verbatim non-math block": "\\begin{verbatim}7\\end{verbatim}",
	"an unterminated \\begin": "7 \\begin{foo}",
};

/** Text between the predecessor and the next block that makes that block's lead-in reach back. */
const REACH_BACKS: Record<string, string> = {
	"`=` on the same line": " = ",
	"`\\` on the same line": " \\to ",
	"a previous line ending in `=`": " =\n",
	"a previous line ending in `(`": " (\n",
	"a previous line ending in `[`": " [\n",
	"a previous line ending in `{`": " {\n",
	"no lead-in": "\n\n",
};

const NEXT_BLOCK = "\\begin{pmatrix}8\\end{pmatrix}";

function count(text: string, marker: string): number {
	return text.split(marker).length - 1;
}

describe("a bare math block after text the scan moved past", () => {
	for (const [predecessor, before] of Object.entries(PREDECESSORS)) {
		for (const [reachBack, between] of Object.entries(REACH_BACKS)) {
			it(`renders ${predecessor} once when the next block's lead-in is ${reachBack}`, () => {
				const rendered = renderMathInText(before + between + NEXT_BLOCK);
				expect({ before: count(rendered, "7"), block: count(rendered, "8") }).toEqual({ before: 1, block: 1 });
				expect(rendered.indexOf("7")).toBeLessThan(rendered.indexOf("8"));
			});
		}
	}

	it("renders two matrices joined by `=` as one equation", () => {
		expect(renderMathInText("\\begin{matrix}a\\end{matrix} = \\begin{matrix}b\\end{matrix}")).toBe("a = b");
	});

	it("keeps a verbatim block and renders the equation after it", () => {
		expect(renderMathInText("\\begin{verbatim}v\\end{verbatim} = \\begin{matrix}b\\end{matrix}")).toBe(
			"\\begin{verbatim}v\\end{verbatim} = b",
		);
	});

	it("still pulls a lead-in the scan has not emitted", () => {
		expect(renderMathInText("x = \\begin{matrix}a\\end{matrix}")).toBe("x = a");
		expect(renderMathInText("x =\n\\begin{matrix}a\\end{matrix}\ny")).toBe("x = a\ny");
	});
});
