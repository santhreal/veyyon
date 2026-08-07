import { beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { PRIORITY_TIER_COMMAND_LABEL, PRIORITY_TIER_LABEL } from "../../../config/service-tier";
import { Settings } from "../../../config/settings";
import type { AgentSession } from "../../../session/agent-session";
import { SYMBOL_PRESETS, type SymbolKey } from "../../theme/symbols";
import { getThemeByName, setThemeInstance, theme } from "../../theme/theme";
import { renderSegment } from "./segments";
import type { SegmentContext } from "./types";

/**
 * The priority service tier reads as a serving tier, never as an effort level.
 *
 * Its icon used to be appended immediately BEFORE the thinking-level glyph and
 * colored with it as `statusLineModel`, so a fast-mode session showed two adjacent
 * same-colored markers on the model label and the tier read as a fourth rung on
 * the effort scale. These cases pin the separation in
 * bytes: distinct color, distinct position, and a word that says what it is.
 */

/** Every effort rung the tier chip must stay visually distinct from. */
const EFFORT_SYMBOL_KEYS: readonly SymbolKey[] = [
	"thinking.minimal",
	"thinking.low",
	"thinking.medium",
	"thinking.high",
	"thinking.xhigh",
	"thinking.max",
	"thinking.autoPending",
];

/** Strip SGR so a case can assert on text, or keep them to assert on color. */
const strip = (text: string): string => stripAnsi(text);

function makeContext(over: { fast: boolean; thinking?: ThinkingLevel; compact?: boolean }): SegmentContext {
	const session = {
		state: {
			model: { name: "Sonnet 4.5", id: "claude-sonnet-4-5", thinking: { levels: ["high"] } },
			thinkingLevel: over.thinking ?? ThinkingLevel.Off,
		},
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isAdvisorActive: () => false,
		isFastModeActive: () => over.fast,
	} as unknown as AgentSession;

	return {
		session,
		activeRepo: null,
		width: 120,
		options: { model: { showThinkingLevel: true } },
		compactThinkingLevel: over.compact ?? false,
		planMode: null,
		prewalk: null,
		loopMode: null,
		goalMode: null,
		vibeMode: null,
		collab: null,
	} as unknown as SegmentContext;
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

describe("the priority tier in the model segment", () => {
	it("is absent when the tier is not realized on the wire", () => {
		const rendered = strip(
			renderSegment("model", makeContext({ fast: false, thinking: ThinkingLevel.High })).content,
		);
		expect(rendered).not.toContain("priority");
	});

	it("names itself, so it cannot be mistaken for an effort rung", () => {
		const rendered = strip(renderSegment("model", makeContext({ fast: true, thinking: ThinkingLevel.High })).content);
		expect(rendered).toContain("priority");
	});

	it("trails the effort rather than sitting between the model name and it", () => {
		// Position is half of the confusion: an icon wedged before the effort glyph
		// reads as part of the same scale.
		const rendered = strip(renderSegment("model", makeContext({ fast: true, thinking: ThinkingLevel.High })).content);
		const effortAt = rendered.indexOf("high");
		const tierAt = rendered.indexOf("priority");
		expect(effortAt).toBeGreaterThan(-1);
		expect(tierAt).toBeGreaterThan(effortAt);
	});

	it("shares no glyph with any effort level, in every symbol preset", () => {
		// The other half of the confusion: even placed last, a glyph from the effort
		// family would still read as one. Checked against EVERY preset rather than
		// the active theme, because `icon.fast` is empty in the unicode preset and a
		// check on the live theme would silently pass by testing nothing.
		const presets = Object.entries(SYMBOL_PRESETS);
		expect(presets.length).toBe(3);
		for (const [preset, symbols] of presets) {
			const icon = symbols["icon.fast"];
			if (!icon) continue;
			for (const key of EFFORT_SYMBOL_KEYS) {
				expect(symbols[key], `${preset} ${key} must not contain the tier icon`).not.toContain(icon);
			}
		}
	});

	it("is colored apart from the model name it follows", () => {
		// `statusLineModel` is the model color and is aliased to `accent` in many
		// themes; the tier uses `warning` so the two never merge into one label.
		const withTier = renderSegment("model", makeContext({ fast: true, thinking: ThinkingLevel.High })).content;
		const withoutTier = renderSegment("model", makeContext({ fast: false, thinking: ThinkingLevel.High })).content;
		const addedSgr = withTier.slice(withoutTier.length - 4);
		expect(addedSgr).toContain(theme.fg("warning", "priority").split("priority")[0]);
	});

	it("still shows the tier when the symbol theme has no fast icon", () => {
		// The plain symbol theme's `icon.fast` is empty, and the old gate
		// (`isFastModeActive() && theme.icon.fast`) rendered NOTHING there, so fast
		// mode was invisible for those users.
		const rendered = strip(renderSegment("model", makeContext({ fast: true })).content);
		expect(rendered).toContain("priority");
	});
});

describe("the tier's name across surfaces", () => {
	/**
	 * The status-line chip and `/fast` used to describe the same state in two
	 * vocabularies ("priority" versus "fast mode"), which is how a serving tier came
	 * to read as an effort level. Both now import one label.
	 */
	it("comes from the shared owner, not a literal in the status line", () => {
		expect(PRIORITY_TIER_LABEL).toBe("priority");
		const rendered = strip(renderSegment("model", makeContext({ fast: true })).content);
		expect(rendered).toContain(PRIORITY_TIER_LABEL);
	});

	it("names the tier in the command wording too, so the surfaces agree", () => {
		expect(PRIORITY_TIER_COMMAND_LABEL.toLowerCase()).toContain(PRIORITY_TIER_LABEL);
	});
});
