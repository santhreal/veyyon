/**
 * WHY:
 * A model read a PNG, the transcript printed `[Image: image/png]`, and the model
 * answered "That is it, rendered above." Both halves of that were defects. The
 * tool result carried the picture into the model's context and said nothing
 * about whether it reached the screen, so a model that held the image reported
 * having shown it; and the row the user actually saw named neither the file nor
 * the fact that something was missing.
 *
 * The class this suite closes: an image entering the model's context through a
 * TOOL RESULT, from any tool, in any terminal state. Both statements have one
 * owner each — `statePlacedImageVisibility` at `convertToLlm`'s `toolResult`
 * case for the model, and `ToolExecutionComponent.#rebuildDisplay` for the user
 * — so the sweeps below derive their variant space at run time: every image
 * protocol the TUI knows, and every renderer in the registry plus the two
 * branches that are not the registry (a tool with its own renderer, and a tool
 * with none). Two siblings found while closing it are covered too: a Kitty
 * session draws only PNG, and a conversion that failed used to leave the block
 * with neither a picture nor a word about one; and a request whose images are
 * scrubbed for a text-only model loses the sentence describing them, since the
 * pictures it describes are no longer in the request.
 *
 * What it does not catch: an image a USER attaches (`@shot.png`, a paste) — the
 * user put it there and knows what it is, so `fileMention` states nothing; a
 * picture lost to a failed PNG conversion is stated to the user but not to the
 * model, because only the component knows the conversion failed and the model's
 * sentence is written before it runs; the WORDING of either sentence beyond the
 * facts it must carry; and whether a terminal that claims a protocol actually
 * drew the picture, which only the terminal can answer.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage, AgentTool } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolExecutionComponent } from "@veyyon/coding-agent/modes/components/tool-execution";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { forgetImageDisplays } from "@veyyon/coding-agent/session/image-visibility";
import { convertToLlm, replaceLlmImagesWithText } from "@veyyon/coding-agent/session/messages";
import { toolRenderers } from "@veyyon/coding-agent/tools/renderers";
import { ImageBudget, ImageProtocol, setTerminalImageProtocol, TERMINAL, type TUI } from "@veyyon/tui";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";
import { createToolExecution } from "./helpers/tool-execution";

/** 1x1 PNG: the smallest payload `getImageDimensions` can measure. */
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

/** The placeholder row's opening, whatever facts and cause follow it. */
const PLACEHOLDER = /… image not shown ·/u;

/**
 * The block wraps at a column that follows the length of the checkout path, so a
 * row can break anywhere, including inside the cause. The facts are read off the
 * rejoined block text: each row drops its gutter rail and the padding that
 * follows the last glyph, and the rows are concatenated without a separator,
 * because a terminal wrap inserts nothing between them. The rail pattern matches
 * one box-drawing or block-element glyph specifically rather than any non-space
 * character, so a renderer that stops drawing a rail fails this loudly instead
 * of quietly eating the first character of every row. The rail these blocks draw
 * is U+258F, a block element, so the class has to reach past the box-drawing
 * range to cover it.
 */
function blockText(rows: readonly string[]): string {
	return rows.map(row => row.replace(/^ *[\u2500-\u259F] ?/u, "").trimEnd()).join("");
}

/**
 * A cause is longer than the facts and wraps wherever the block's width leaves
 * it, so a sentence is compared with every space taken out of both sides rather
 * than guessing where the break lands.
 */
function squeezed(text: string): string {
	return text.replace(/\s+/gu, "");
}

function imageToolResult(toolName: string, images = 1, toolCallId = "call_1"): AgentMessage {
	const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
		{ type: "text", text: "Read image file [image/png]" },
	];
	for (let i = 0; i < images; i++) content.push({ type: "image", data: TINY_PNG, mimeType: "image/png" });
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content,
		timestamp: 1,
		isError: false,
	} as AgentMessage;
}

/** The text blocks a converted message carries, in order. */
function textBlocks(message: AgentMessage): string[] {
	const [converted] = convertToLlm([message]);
	if (!converted) return [];
	if (typeof converted.content === "string") return [converted.content];
	return converted.content.filter(block => block.type === "text").map(block => block.text);
}

interface BlockCase {
	tool?: AgentTool;
	showImages?: boolean;
	args?: Record<string, unknown>;
	content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	/** Called when the block asks for a repaint — the signal an async image step landed. */
	onRender?: () => void;
	/** The call this block belongs to, which is what a late decision is recorded against. */
	toolCallId?: string;
	/** A real budget, so a demotion is decided the way a session decides one. */
	budget?: ImageBudget;
}

function blockComponent(toolName: string, blockCase: BlockCase = {}): ToolExecutionComponent {
	const onRender = blockCase.onRender ?? ((): void => {});
	const ui = {
		requestRender: onRender,
		requestComponentRender: onRender,
		imageBudget: blockCase.budget,
	} as unknown as TUI;
	const component = createToolExecution(
		toolName,
		blockCase.args ?? { path: "shots/board.png" },
		{ showImages: blockCase.showImages ?? true },
		blockCase.tool,
		ui,
		process.cwd(),
		blockCase.toolCallId,
	);
	component.setArgsComplete();
	component.updateResult(
		{
			content: blockCase.content ?? [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: TINY_PNG, mimeType: "image/png" },
			],
			details: blockCase.details ?? { resolvedPath: `${process.cwd()}/shots/board.png` },
		},
		false,
	);
	return component;
}

function rowsOf(component: ToolExecutionComponent): string[] {
	return component.render(100).map(line => Bun.stripANSI(line));
}

async function renderBlock(toolName: string, blockCase: BlockCase = {}): Promise<string[]> {
	const component = blockComponent(toolName, blockCase);
	await component.whenPreviewSettled();
	return rowsOf(component);
}

/** A tool that draws its own result, which is the branch `read` takes. */
const CUSTOM_RENDERED_TOOL = {
	name: "paints_itself",
	label: "paints_itself",
	renderResult: () => ({ render: (): readonly string[] => ["a body this tool laid out itself"] }),
} as unknown as AgentTool;

let settingsState: SettingsTestState | undefined;
let originalProtocol: ImageProtocol | null = null;

beforeAll(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
	originalProtocol = TERMINAL.imageProtocol;
});

afterEach(() => {
	setTerminalImageProtocol(originalProtocol);
	Settings.instance.set("terminal.showImages", true);
	forgetImageDisplays();
});

afterAll(() => {
	setTerminalImageProtocol(originalProtocol);
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

describe("a model is told when the user cannot see the image", () => {
	it("states nothing extra in a terminal that draws the picture, for every protocol the TUI knows", () => {
		const drawn = new Map<ImageProtocol, string[]>();
		for (const protocol of Object.values(ImageProtocol)) {
			setTerminalImageProtocol(protocol);
			drawn.set(protocol, textBlocks(imageToolResult("read")));
		}

		// The variant space is the enum, pinned so a fourth protocol reds this
		// suite until someone decides what it means for visibility.
		expect(Object.values(ImageProtocol).sort()).toEqual(
			[ImageProtocol.Iterm2, ImageProtocol.Kitty, ImageProtocol.Sixel].sort(),
		);
		for (const [protocol, blocks] of drawn) {
			expect(blocks, `protocol ${JSON.stringify(protocol)}`).toEqual(["Read image file [image/png]"]);
		}
	});

	it("states that the picture never reached the screen when the terminal has no protocol", () => {
		setTerminalImageProtocol(null);
		const blocks = textBlocks(imageToolResult("read"));

		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toBe("Read image file [image/png]");
		expect(blocks[1]).toContain("in your context only");
		expect(blocks[1]).toContain("this terminal has no image protocol");
		expect(blocks[1]).toContain("do not tell the user you displayed it");
	});

	it("names the setting when a capable terminal has images turned off", () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		Settings.instance.set("terminal.showImages", false);
		const blocks = textBlocks(imageToolResult("read"));

		expect(blocks).toHaveLength(2);
		expect(blocks[1]).toContain("terminal.showImages");
	});

	it("counts the images and appends the statement once, after the last of them", () => {
		setTerminalImageProtocol(null);
		const [converted] = convertToLlm([imageToolResult("read", 3)]);
		if (!converted || typeof converted.content === "string") throw new Error("expected content blocks");
		const kinds = converted.content.map(block => block.type);

		expect(kinds).toEqual(["text", "image", "image", "image", "text"]);
		const last = converted.content.at(-1);
		expect(last?.type === "text" && last.text).toContain("These 3 images are in your context only");
	});

	it("does not consult the tool, so a tool it has never heard of is covered too", () => {
		setTerminalImageProtocol(null);
		const blocks = textBlocks(imageToolResult("a_tool_invented_after_this_test"));

		expect(blocks).toHaveLength(2);
		expect(blocks[1]).toContain("in your context only");
	});

	it("leaves a result that carries no image exactly as it was", () => {
		setTerminalImageProtocol(null);
		const blocks = textBlocks({
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "plain text output" }],
			timestamp: 1,
			isError: false,
		} as AgentMessage);

		expect(blocks).toEqual(["plain text output"]);
	});

	// A request served by a text-only model, or one an operator blocked images
	// on, carries no picture at all. The sentence describing where the picture is
	// goes with it, so the model is not told about an image the request does not
	// contain.
	it("drops the statement when the images themselves are scrubbed from the request", () => {
		setTerminalImageProtocol(null);
		const converted = convertToLlm([imageToolResult("read", 2)]);
		const beforeScrub = converted[0];
		if (!beforeScrub || typeof beforeScrub.content === "string") throw new Error("expected content blocks");
		expect(beforeScrub.content.map(block => block.type)).toEqual(["text", "image", "image", "text"]);

		const scrubbed = replaceLlmImagesWithText(converted, "[image omitted]");
		const result = scrubbed[0];
		if (!result || typeof result.content === "string") throw new Error("expected content blocks");

		expect(result.content).toEqual([
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "text", text: "[image omitted]" },
		]);
	});
});

describe("a picture the terminal cannot draw leaves a row that says so", () => {
	it("shows the placeholder under every renderer in the registry", async () => {
		setTerminalImageProtocol(null);
		const silent: string[] = [];

		for (const name of Object.keys(toolRenderers).sort()) {
			const rows = await renderBlock(name);
			if (!rows.some(row => PLACEHOLDER.test(row))) silent.push(name);
		}

		expect(silent).toEqual([]);
	});

	it("shows it for a tool that draws its own result, and for one with no renderer at all", async () => {
		setTerminalImageProtocol(null);

		const own = await renderBlock("paints_itself", { tool: CUSTOM_RENDERED_TOOL });
		expect(own.some(row => row.includes("a body this tool laid out itself"))).toBe(true);
		expect(own.some(row => PLACEHOLDER.test(row))).toBe(true);

		const bare = await renderBlock("a_tool_with_no_renderer");
		expect(bare.some(row => PLACEHOLDER.test(row))).toBe(true);
	});

	it("shows it for a picture a tool kept in its details rather than its content", async () => {
		setTerminalImageProtocol(null);
		const rows = await renderBlock("generate_image", {
			content: [{ type: "text", text: "Generated 1 image" }],
			details: { images: [{ data: TINY_PNG, mimeType: "image/png" }] },
		});

		expect(rows.some(row => PLACEHOLDER.test(row))).toBe(true);
	});

	it("names the file, the pixel size and the cause, and drops the media type the file name states", async () => {
		setTerminalImageProtocol(null);
		// A block whose own body never prints the path, so the file name in the
		// row can only have come from the placeholder itself.
		const rows = await renderBlock("a_tool_with_no_renderer", { args: {} });
		// The block's own body says `Read image file [image/png]`, so the media type
		// is read off the placeholder sentence rather than the whole block.
		const placeholder = /… image not shown · (?<facts>[^(]+)\((?<cause>[^)]+)\)/u.exec(blockText(rows));
		if (!placeholder?.groups) throw new Error(`no placeholder row in:\n${blockText(rows)}`);
		const facts = placeholder.groups.facts.trim();

		expect(facts).toMatch(/board\.png · 1x1$/u);
		// `board.png` and `image/png` state the same fact, and the row states it once.
		expect(facts).not.toContain("image/png");
		expect(placeholder.groups.cause).toBe("no image protocol");
	});

	it("blames the setting, not the terminal, when a capable terminal has images off", async () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const rows = await renderBlock("read", { showImages: false });

		expect(squeezed(blockText(rows))).toContain(squeezed("(images off, turn on Show Inline Images in /settings)"));
	});

	it("says so when a Kitty session cannot convert the picture to PNG", async () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		// Kitty draws only PNG. This payload is not an image at all, so the
		// conversion rejects and the picture can never appear; the block asks for a
		// repaint when that lands, which is the signal awaited here instead of a
		// delay.
		const repainted = Promise.withResolvers<void>();
		const component = blockComponent("read", {
			content: [
				{ type: "text", text: "Read image file [image/jpeg]" },
				{ type: "image", data: Buffer.from("not an image").toString("base64"), mimeType: "image/jpeg" },
			],
			onRender: () => repainted.resolve(),
		});

		await repainted.promise;
		const rows = rowsOf(component);
		expect(squeezed(blockText(rows))).toContain(squeezed("(unsupported format)"));
	});

	it("draws no placeholder when the picture itself is on screen", async () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const rows = await renderBlock("read");

		expect(rows.filter(row => PLACEHOLDER.test(row))).toEqual([]);
	});

	it("states the missing picture once, not once per render path", async () => {
		setTerminalImageProtocol(null);
		const rows = await renderBlock("read");

		expect(rows.filter(row => PLACEHOLDER.test(row))).toHaveLength(1);
	});
});

// Two causes are settled after the sentence was first written, per image, inside
// the block: the session's image budget demotes an older picture when a newer
// one arrives, and a Kitty session cannot convert a payload it does not draw. In
// both cases the user is looking at a placeholder row, so the model must stop
// being told the picture is on screen.
describe("a picture the block gave up on stops being reported as displayed", () => {
	it("states a budget demotion, and stops once the picture draws again", async () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const budget = new ImageBudget(1, () => {});
		const component = blockComponent("read", {
			toolCallId: "call_budget",
			budget,
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: TINY_PNG, mimeType: "image/png" },
				{ type: "image", data: TINY_PNG, mimeType: "image/png" },
			],
		});
		await component.whenPreviewSettled();

		// The budget plans a demotion from what the first pass observed and applies
		// it on the next one, which is how a session reaches the same state. A kitty
		// session prepares the payload off the render path, so the pair of passes
		// repeats until the pictures exist to be demoted, under a deadline.
		const budgetDeadline = Date.now() + 3000;
		let rows: string[] = [];
		while (Date.now() < budgetDeadline) {
			budget.beginPass();
			component.render(100);
			budget.endPass();
			budget.beginPass();
			rows = component.render(100).map(line => Bun.stripANSI(line));
			budget.endPass();
			if (
				squeezed(blockText(rows)).includes(
					squeezed("(over the image budget, raise Live Image Budget in /settings)"),
				)
			)
				break;
			await Bun.sleep(5);
		}

		expect(squeezed(blockText(rows))).toContain(
			squeezed("(over the image budget, raise Live Image Budget in /settings)"),
		);
		const blocks = textBlocks(imageToolResult("read", 2, "call_budget"));
		expect(blocks).toHaveLength(2);
		expect(blocks[1]).toContain("1 of these 2 images is in your context only");
		expect(blocks[1]).toContain("the session's image budget is full");

		// Room again: the picture draws, and the sentence goes with the demotion.
		budget.setCap(0);
		budget.beginPass();
		component.render(100);
		budget.endPass();

		expect(textBlocks(imageToolResult("read", 2, "call_budget"))).toEqual(["Read image file [image/png]"]);
	});

	it("states a failed Kitty conversion", async () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const repainted = Promise.withResolvers<void>();
		const component = blockComponent("read", {
			toolCallId: "call_convert",
			content: [
				{ type: "text", text: "Read image file [image/jpeg]" },
				{ type: "image", data: Buffer.from("not an image").toString("base64"), mimeType: "image/jpeg" },
			],
			onRender: () => repainted.resolve(),
		});

		await repainted.promise;
		rowsOf(component);
		const blocks = textBlocks(imageToolResult("read", 1, "call_convert"));

		expect(blocks).toHaveLength(2);
		expect(blocks[1]).toContain("this terminal cannot draw this image format");
	});

	it("says nothing about another call's pictures", async () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const repainted = Promise.withResolvers<void>();
		const component = blockComponent("read", {
			toolCallId: "call_convert",
			content: [
				{ type: "text", text: "Read image file [image/jpeg]" },
				{ type: "image", data: Buffer.from("not an image").toString("base64"), mimeType: "image/jpeg" },
			],
			onRender: () => repainted.resolve(),
		});
		await repainted.promise;
		rowsOf(component);

		expect(textBlocks(imageToolResult("read", 1, "another_call"))).toEqual(["Read image file [image/png]"]);
	});

	// A block that recorded a decision and then gets a protocol builds a NEW image
	// component, which reports only a CHANGE and so reports nothing when it draws
	// on its first pass. The rebuild has to drop the old decision itself.
	it("drops a recorded decision when the rebuild draws the picture", async () => {
		setTerminalImageProtocol(null);
		const component = blockComponent("read", { toolCallId: "call_returns" });
		await component.whenPreviewSettled();
		rowsOf(component);
		expect(textBlocks(imageToolResult("read", 1, "call_returns"))).toHaveLength(2);

		setTerminalImageProtocol(ImageProtocol.Kitty);
		component.setExpanded(true);
		rowsOf(component);

		expect(textBlocks(imageToolResult("read", 1, "call_returns"))).toEqual(["Read image file [image/png]"]);
	});
});
