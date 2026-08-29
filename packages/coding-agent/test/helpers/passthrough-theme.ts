/**
 * A theme whose colour functions are identity, over the glyph sets the chrome
 * actually asks for.
 *
 * WHY THE GLYPHS ARE DERIVED. A hand-written `boxSharp` literal is a second
 * definition of the chrome's glyph set, and it goes stale in silence: two
 * console suites carried one, and both died on `undefined is not an object` the
 * moment a card's shape moved to `boxRound`, because the frame builder read a
 * set the fake did not carry. `getSymbolTheme()` is the symbol layer's own
 * answer — the ASCII preset while no theme is published, which is the state a
 * unit suite runs in — so a set the chrome reads is a set this fake has.
 *
 * Colour is what is stripped here, not structure: `fg` and `bold` return their
 * text so a frame assertion reads plain characters.
 */
import { getSymbolTheme } from "../../src/modes/theme/symbol-theme";
import type { Theme } from "../../src/modes/theme/theme-class";

export function passthroughTheme(): Theme {
	const symbols = getSymbolTheme();
	return {
		fg: (_name: string, text: string) => text,
		bold: (text: string) => text,
		boxRound: symbols.boxRound,
		boxSharp: symbols.boxSharp,
	} as unknown as Theme;
}
