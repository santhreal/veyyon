/**
 * WHY THIS EXISTS. Each assistant segment built its `Markdown` with a style literal, and `Markdown`
 * keys its module-level render cache on the style object's identity. A component rebuilt for a
 * message it had already drawn (a transcript rebuild, a resume, a tree navigation) therefore rendered
 * every segment again, and every segment held one more style object and closure. The role style is
 * now one object per role (`markdownTextStyle`).
 *
 * The class: every role an assistant message paints prose in (answer text, thinking) reuses the rows
 * of the component it replaces, and still paints what a style built for that component alone paints,
 * under each theme. The theme arm catches a shared style that captured the theme at construction
 * instead of reading the live binding.
 *
 * What it does not catch: some other component that builds its style per instance. No runtime
 * registry lists `Markdown` construction sites, so a new one is found by reading, not by this suite.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/assistant-message";
import type { ThemeColor, ThemeJson } from "@veyyon/coding-agent/theme/color";
import { getDefaultThemes } from "@veyyon/coding-agent/theme/defaults";
import { getMarkdownTheme, markdownTextStyle } from "@veyyon/coding-agent/theme/markdown-theme";
import { createTheme, initTheme, setThemeInstance, theme } from "@veyyon/coding-agent/theme/theme";
import type { Theme } from "@veyyon/coding-agent/theme/theme-class";
import { type AnsiPolicy, type Component, Container, getAnsiPolicy, Markdown, setAnsiPolicy } from "@veyyon/tui";
import type { AssistantMessageView, AssistantSegment } from "@veyyon/wire/presentation";

const WIDTH = 80;

interface RoleCase {
	name: string;
	role: ThemeColor;
	italic: boolean;
	segment: AssistantSegment;
	text: string;
}

const ANSWER = "The answer has **bold**, `code` and a [link](https://example.com).";
const THINKING = "Weighing **two** options before the answer.";

const ROLES: RoleCase[] = [
	{ name: "answer text", role: "text", italic: false, segment: { kind: "text", text: ANSWER }, text: ANSWER },
	{
		name: "thinking",
		role: "thinkingText",
		italic: true,
		segment: { kind: "thinking", text: THINKING, rawThinking: THINKING, redacted: false },
		text: THINKING,
	},
];

/** Two bundled themes that paint both roles in explicit, different colours. */
const THEMES = ["dark-poimandres", "light-cyberpunk"] as const;

function view(segment: AssistantSegment): AssistantMessageView {
	return { segments: [segment], model: "m", stopReason: "complete", errorPresentation: { kind: "none" } };
}

function segmentMarkdown(segment: AssistantSegment): Markdown {
	const component = new AssistantMessageComponent();
	component.updateContent(view(segment));
	const found: Markdown[] = [];
	const walk = (node: Component): void => {
		if (node instanceof Markdown) found.push(node);
		if (node instanceof Container) for (const child of node.children) walk(child);
	};
	walk(component);
	expect(found.length).toBe(1);
	return found[0]!;
}

let priorTheme: Theme;
/** Colour is forced on: under a piped policy the theme arm would compare bare text. */
let priorPolicy: AnsiPolicy;

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	priorTheme = theme;
	priorPolicy = getAnsiPolicy();
	setAnsiPolicy("full");
});

afterEach(() => {
	setThemeInstance(priorTheme);
	setAnsiPolicy(priorPolicy);
	resetSettingsForTest();
});

describe("a rebuilt assistant message", () => {
	for (const c of ROLES) {
		it(`reuses the ${c.name} rows its predecessor rendered`, () => {
			const first = segmentMarkdown(c.segment).render(WIDTH);
			const rebuilt = segmentMarkdown(c.segment).render(WIDTH);
			expect(rebuilt).toBe(first);
		});

		it(`paints ${c.name} as a style of its own paints it, under each theme`, () => {
			const painted: string[][] = [];
			for (const name of THEMES) {
				setThemeInstance(createTheme(getDefaultThemes()[name] as ThemeJson, { mode: "truecolor" }));
				const own = new Markdown(c.text, 2, 0, getMarkdownTheme(), {
					color: (text: string) => theme.fg(c.role, text),
					italic: c.italic,
				}).render(WIDTH);
				const rows = [...segmentMarkdown(c.segment).render(WIDTH)];
				expect(rows).toEqual([...own]);
				painted.push(rows);
			}
			expect(painted[0]).not.toEqual(painted[1]);
		});
	}
});

describe("a role style", () => {
	it("keeps a role asked for plain and italic as two styles, in either order", () => {
		for (const [role, italicFirst] of [
			["accent", false],
			["muted", true],
		] as const) {
			const draw = (italic: boolean): string[] => {
				const style = markdownTextStyle(role, italic);
				return [...new Markdown(ANSWER, 0, 0, getMarkdownTheme(), style).render(WIDTH)];
			};
			const own = (italic: boolean): string[] => [
				...new Markdown(ANSWER, 0, 0, getMarkdownTheme(), {
					color: (text: string) => theme.fg(role, text),
					italic,
				}).render(WIDTH),
			];
			const first = draw(italicFirst);
			const second = draw(!italicFirst);
			expect(first).toEqual(own(italicFirst));
			expect(second).toEqual(own(!italicFirst));
			expect(first).not.toEqual(second);
		}
	});
});
