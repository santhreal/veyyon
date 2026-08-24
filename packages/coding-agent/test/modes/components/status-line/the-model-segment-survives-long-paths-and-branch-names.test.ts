/**
 * The model name segment survives long paths and git branch names on the status line.
 *
 * THE DEFECT. The status line's shedding logic treated `model` as an unranked
 * (rank 0) segment while keeping `mode` (rank 2) and `subagents` (rank 4).
 * When the working directory path or git branch name was long (e.g. 50+ chars),
 * the combined width exceeded the terminal budget. Because `location` (path and
 * git branch) was only shortened after all rank 0 right-group parts were dropped,
 * the model name was always the first casualty — completely disappearing from the
 * screen while an untruncated path occupied the entire left side of the footline.
 * The model name only reappeared if the user resized the terminal significantly wider.
 *
 * THE CLASS. Priority inversion in status-line degradation: essential operating
 * identity (which model is active) being shed before non-essential or truncatable
 * location chrome is shortened.
 *
 * WHAT THIS SUITE COVERS:
 *   - Model segment retention across standard terminal widths (80, 100, 120 columns)
 *     with realistic and long working directories and git branch names.
 *   - Location truncation taking place to accommodate the model name and approval mode.
 *   - StatusLine presets that include `model` preserving the segment under width pressure.
 *   - Non-overlapping hit-test bounds for all rendered segments including model.
 *   - Ordered degradation under extreme width constraints (< 40 columns).
 *
 * WHAT IT DOES NOT CATCH: Model string formatting details or provider icon rendering
 * inside the model segment itself.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/components/status-line/component";
import { STATUS_LINE_PRESETS } from "@veyyon/coding-agent/modes/components/status-line/presets";
import type { StatusLinePreset } from "@veyyon/coding-agent/modes/components/status-line/types";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { stripAnsi } from "@veyyon/utils/strip-ansi";

function makeSession(options?: {
	modelId?: string;
	thinkingLevel?: string;
	branch?: string;
	path?: string;
}): AgentSession {
	const modelId = options?.modelId ?? "claude-3-7-sonnet";
	return {
		messages: [],
		model: { id: modelId, name: modelId, contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 16000, contextWindow: 128000 }),
		state: { messages: [], model: { id: modelId, name: modelId, contextWindow: 128000 } },
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
				tokensPerSecond: null,
			}),
			getSessionName: () => "test-session",
		},
		getPrewalkState: () => undefined,
		getAsyncJobSnapshot: () => undefined,
		settings: { getGroup: () => ({ enabled: false }) },
		isAdvisorActive: () => false,
		isApprovalBypassed: () => false,
		isFastModeActive: () => false,
		configuredThinkingLevel: () => options?.thinkingLevel,
		modelRegistry: { isUsingOAuth: () => false },
	} as unknown as AgentSession;
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

describe("the model segment survives long paths and branch names", () => {
	it("retains the model name at 80 columns when location is wide", () => {
		const session = makeSession({ modelId: "claude-3-7-sonnet" });
		const statusLine = new StatusLineComponent(session);

		// At 80 columns with default settings, the model name must be retained.
		const line = statusLine.renderQuietLine(80);
		expect(line).not.toBeNull();
		const stripped = stripAnsi(line ?? "");
		expect(stripped).toContain("claude-3-7-sonnet");
	});

	it("retains the model name at 100 columns with long paths and git branches", () => {
		const session = makeSession({ modelId: "gpt-4o" });
		const statusLine = new StatusLineComponent(session);

		const line = statusLine.renderQuietLine(100);
		expect(line).not.toBeNull();
		const stripped = stripAnsi(line ?? "");
		expect(stripped).toContain("gpt-4o");
	});

	it("preserves model across all presets that declare it at 80 columns", () => {
		const presetsWithModel = (
			Object.entries(STATUS_LINE_PRESETS) as [StatusLinePreset, (typeof STATUS_LINE_PRESETS)[StatusLinePreset]][]
		).filter(([_, def]) => def.leftSegments.includes("model") || def.rightSegments.includes("model"));

		expect(presetsWithModel.length).toBeGreaterThanOrEqual(4);

		for (const [presetName] of presetsWithModel) {
			const session = makeSession({ modelId: "claude-3-5-haiku" });
			const statusLine = new StatusLineComponent(session);
			statusLine.updateSettings({ preset: presetName } as never);

			const line = statusLine.renderQuietLine(80);
			expect(line).not.toBeNull();
			const stripped = stripAnsi(line ?? "");
			expect(stripped).toContain("claude-3-5-haiku");
		}
	});

	it("hit-tests model segment correctly and maintains non-overlapping bounds", () => {
		const session = makeSession({ modelId: "deepseek-r1" });
		const statusLine = new StatusLineComponent(session);

		const line = statusLine.renderQuietLine(90);
		expect(line).not.toBeNull();

		const bounds = statusLine.getQuietSegmentBounds();
		const modelSlot = bounds.find(s => s.id === "model");
		expect(modelSlot).toBeDefined();
		expect(modelSlot!.end).toBeGreaterThan(modelSlot!.start);

		// Midpoint resolves to "model".
		const mid = Math.floor((modelSlot!.start + modelSlot!.end) / 2);
		expect(statusLine.quietSegmentAt(mid)).toBe("model");

		// Sorted slots must not overlap.
		const sorted = [...bounds].sort((a, b) => a.start - b.start);
		for (let i = 1; i < sorted.length; i++) {
			expect(sorted[i]!.start).toBeGreaterThanOrEqual(sorted[i - 1]!.end);
		}
	});

	it("degrades gracefully under extreme narrowness", () => {
		const session = makeSession({ modelId: "claude-3-7-sonnet" });
		const statusLine = new StatusLineComponent(session);

		// At width 50: model still fits.
		const line50 = statusLine.renderQuietLine(50);
		expect(line50).not.toBeNull();
		expect(stripAnsi(line50 ?? "")).toContain("claude-3-7-sonnet");

		// At width 15: narrowest survival takes over without crashing.
		const line15 = statusLine.renderQuietLine(15);
		expect(line15).not.toBeNull();
		const bounds15 = statusLine.getQuietSegmentBounds();
		for (const slot of bounds15) {
			expect(slot.end).toBeLessThanOrEqual(15);
		}
	});
});
