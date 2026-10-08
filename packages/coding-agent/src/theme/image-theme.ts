import type { ImageTheme } from "@veyyon/tui";
import { theme } from "./theme-binding";

/**
 * The colour an inline image's fallback text is drawn in: the tool-output colour of the theme active
 * when it draws. One object for every image, so an image a transcript keeps holds no closure of its own.
 */
export const TOOL_OUTPUT_IMAGE_THEME: ImageTheme = {
	fallbackColor: text => theme.fg("toolOutput", text),
};
