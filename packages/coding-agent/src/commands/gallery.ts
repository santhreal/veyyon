import { errorMessage } from "@veyyon/utils";
/**
 * Render every built-in tool's renderer across its lifecycle states.
 */
import { Command, Flags } from "@veyyon/utils/cli";
import { GALLERY_STATE_TOKENS, type GalleryState, parseGalleryStates, runGalleryCommand } from "../cli/gallery-cli";

export default class Gallery extends Command {
	static description = "Preview tool renderers across streaming, in-progress, success, and failure states";

	static devTool = true;

	static flags = {
		tool: Flags.string({ char: "t", description: "Render a single tool by name" }),
		theme: Flags.string({
			description:
				"Render in the named theme(s) instead of the profile's active theme; repeatable. Each theme suffixes its output (-<theme>). An unknown name fails; the profile's stored theme is not changed.",
			multiple: true,
		}),
		state: Flags.string({
			char: "s",
			description: "Render only the given lifecycle state(s)",
			options: GALLERY_STATE_TOKENS,
			multiple: true,
		}),
		width: Flags.integer({ char: "w", description: "Render width in columns" }),
		expanded: Flags.boolean({
			char: "e",
			description: "Render the expanded variant of each renderer",
			default: false,
		}),
		plain: Flags.boolean({ description: "Strip ANSI styling from the output", default: false }),
		screenshot: Flags.boolean({
			description:
				"Capture the rendered output as PNG screenshot(s) via VHS instead of printing ANSI (requires vhs)",
			default: false,
		}),
		out: Flags.string({
			char: "o",
			description: "Screenshot output path (with --screenshot); suffixed per image when split across multiple",
		}),
		font: Flags.string({ description: "Screenshot font family (default: JetBrainsMono Nerd Font)" }),
		"font-size": Flags.integer({ description: "Screenshot font size in points (default: 18)" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Gallery);
		let states: GalleryState[] | undefined;
		try {
			states = parseGalleryStates(flags.state);
		} catch (err) {
			process.stderr.write(`${errorMessage(err)}\n`);
			process.exitCode = 1;
			return;
		}
		await runGalleryCommand({
			tool: flags.tool,
			themes: flags.theme,
			states,
			width: flags.width,
			expanded: flags.expanded,
			plain: flags.plain,
			screenshot: flags.screenshot,
			out: flags.out,
			font: flags.font,
			fontSize: flags["font-size"],
		});
	}
}
