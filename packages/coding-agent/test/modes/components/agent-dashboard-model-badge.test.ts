/**
 * The model badge on a Live roster row: which model an agent runs on.
 *
 * WHY THESE TESTS. The badge has three possible sources and they do not all
 * exist at the same time. A running agent's model comes from the session
 * observer, which reports what the executor RESOLVED; an agent that is parked,
 * or that registered a moment before its session reference landed, has no
 * observer entry at all and only the model recorded on its registry ref. Before
 * that fallback existed, exactly those rows showed no model, which is the
 * opposite of useful: an agent you cannot see running is the one you most want
 * to know the cost of.
 *
 * The formatting itself has one owner, `agent-model-badge.ts`, shared with the
 * task widget. It used to be two, and the same agent read as `sonnet-4-6 high`
 * on the card and `anthropic/sonnet-4-6:high` in the transcript.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { SessionObserverRegistry } from "@veyyon/coding-agent/modes/session-observer-registry";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentProgress } from "@veyyon/coding-agent/task/types";
import { stubStdoutGeometry, type StubbedStdoutGeometry } from "../../helpers/stdout-geometry";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	AgentRegistry.resetGlobalForTests();
	geometry = stubStdoutGeometry({ columns: 120, rows: 40 });
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	geometry.restore();
});

function frameOf(dashboard: AgentDashboard): string {
	return dashboard.render(120).join("\n").replace(ANSI_PATTERN, "");
}

/** An observer registry that reports one agent's executor-resolved model. */
function observersReporting(id: string, resolvedModel: string, fellBackFrom?: string): SessionObserverRegistry {
	const observers = new SessionObserverRegistry();
	observers.getSessions = () => [
		{
			id,
			kind: "subagent",
			label: "Subagent",
			status: "active",
			lastUpdate: Date.now(),
			// Only the fields the badge reads; the rest of AgentProgress describes the
			// task widget's own row and has no bearing on which model is shown.
			progress: { resolvedModel, fellBackFrom } as AgentProgress,
		},
	];
	return observers;
}

describe("Model badge sources", () => {
	/**
	 * The gap this fallback fills. A parked agent, or one registered before its
	 * session reference lands, has no observer entry, so the only model anyone
	 * knows is the one recorded on the ref at registration. Such a row used to
	 * render with no model at all.
	 */
	test("falls back to the model recorded on the registry ref when no session is attached", () => {
		AgentRegistry.global().register({
			id: "Scout",
			displayName: "scout",
			kind: "sub",
			session: null,
			status: "parked",
			model: "anthropic/claude-opus-4-8",
		});
		const dashboard = new AgentDashboard({ terminalHeight: 40, showModelBadge: true });

		const shown = frameOf(dashboard);

		expect(shown).toContain("claude-opus-4-8");
		dashboard.dispose();
	});

	/**
	 * The provider prefix is dropped. Every agent in a session usually runs on the
	 * same provider, so the prefix is a column of identical text pushing the one
	 * thing that differs off the end of a narrow row.
	 */
	test("drops the provider prefix and keeps the model id", () => {
		AgentRegistry.global().register({
			id: "Scout",
			displayName: "scout",
			kind: "sub",
			session: null,
			status: "parked",
			model: "anthropic/claude-opus-4-8",
		});
		const dashboard = new AgentDashboard({ terminalHeight: 40, showModelBadge: true });

		const shown = frameOf(dashboard);

		expect(shown).not.toContain("anthropic/");
		dashboard.dispose();
	});

	/**
	 * Live beats recorded. The ref's model is what the agent was LAUNCHED with;
	 * the observer reports what the executor actually resolved, which is the model
	 * the tokens are being spent on when the two differ.
	 */
	test("prefers the executor-resolved model over the one recorded at registration", () => {
		AgentRegistry.global().register({
			id: "Scout",
			displayName: "scout",
			kind: "sub",
			session: null,
			status: "running",
			model: "anthropic/claude-opus-4-8",
		});
		const dashboard = new AgentDashboard({
			terminalHeight: 40,
			showModelBadge: true,
			observers: observersReporting("Scout", "openai/gpt-5-2"),
		});

		const shown = frameOf(dashboard);

		expect(shown).toContain("gpt-5-2");
		expect(shown).not.toContain("claude-opus-4-8");
		dashboard.dispose();
	});

	/**
	 * An agent that fell back to a later entry in its model chain is marked, the
	 * same way the Subagents HUD block marks it. Without the mark the roster shows
	 * a model that reads as a deliberate choice, so an agent quietly demoted by a
	 * provider error is indistinguishable from one you pinned there yourself.
	 */
	test("marks a row whose model came from a fallback, and leaves a normal row unmarked", () => {
		AgentRegistry.global().register({
			id: "Scout",
			displayName: "scout",
			kind: "sub",
			session: null,
			status: "running",
			model: "anthropic/claude-opus-4-8",
		});
		const fellBack = new AgentDashboard({
			terminalHeight: 40,
			showModelBadge: true,
			observers: observersReporting("Scout", "openai/gpt-5-2", "anthropic/claude-opus-4-8"),
		});
		const plain = new AgentDashboard({
			terminalHeight: 40,
			showModelBadge: true,
			observers: observersReporting("Scout", "openai/gpt-5-2"),
		});

		expect(frameOf(fellBack)).toContain("↓gpt-5-2");
		expect(frameOf(plain)).not.toContain("↓");
		fellBack.dispose();
		plain.dispose();
	});

	/**
	 * A reasoning level is part of what the row costs, so it rides with the model.
	 * `Off` and `Inherit` print nothing extra: they are the absence of a choice,
	 * and a badge saying "inherit" spends a column to say the row is like every
	 * other row.
	 */
	test("shows the reasoning level beside the model when one is selected", () => {
		AgentRegistry.global().register({
			id: "Scout",
			displayName: "scout",
			kind: "sub",
			session: null,
			status: "running",
			model: "anthropic/claude-opus-4-8:high",
		});
		const dashboard = new AgentDashboard({ terminalHeight: 40, showModelBadge: true });

		const shown = frameOf(dashboard);

		expect(shown).toContain("claude-opus-4-8");
		expect(shown).toContain("high");
		dashboard.dispose();
	});

	/**
	 * Adversarial: a model id may itself contain a colon. Splitting on the FIRST
	 * colon turned `ollama/qwen3:14b` into the model `qwen3` at an invented
	 * reasoning level called `14b`, which is a model the operator does not run
	 * printed on the row of an agent that is running.
	 */
	test("keeps a colon that belongs to the model id rather than reading it as a level", () => {
		AgentRegistry.global().register({
			id: "Scout",
			displayName: "scout",
			kind: "sub",
			session: null,
			status: "running",
			model: "ollama/qwen3:14b",
		});
		const dashboard = new AgentDashboard({ terminalHeight: 40, showModelBadge: true });

		const shown = frameOf(dashboard);

		expect(shown).toContain("qwen3:14b");
		dashboard.dispose();
	});

	/** No model anywhere means no badge, not an empty pair of decorations. */
	test("renders no badge when neither the ref nor the observer knows a model", () => {
		AgentRegistry.global().register({
			id: "Bare",
			displayName: "scout",
			kind: "sub",
			session: null,
			status: "parked",
		});
		const dashboard = new AgentDashboard({ terminalHeight: 40, showModelBadge: true });

		const shown = frameOf(dashboard);

		expect(shown).toContain("Kestrel");
		expect(shown).not.toContain("claude");
		expect(shown).not.toContain("gpt");
		dashboard.dispose();
	});
});

describe("The showResolvedModelBadge gate", () => {
	/**
	 * The badge is a setting (`subagent.showResolvedModelBadge`), and the card
	 * honours it rather than deciding for itself. An operator who turned the badge
	 * off in the transcript did so to stop reading model ids, and a second surface
	 * that showed them anyway would make the setting a lie.
	 */
	test("shows no badge when the setting is off, even with a model on the ref", () => {
		AgentRegistry.global().register({
			id: "Scout",
			displayName: "scout",
			kind: "sub",
			session: null,
			status: "parked",
			model: "anthropic/claude-opus-4-8",
		});
		const dashboard = new AgentDashboard({ terminalHeight: 40, showModelBadge: false });

		const shown = frameOf(dashboard);

		expect(shown).toContain("Kestrel");
		expect(shown).not.toContain("claude-opus-4-8");
		dashboard.dispose();
	});

	/** And the same roster with the setting on does show it, so the test above is not vacuous. */
	test("shows the badge for the same roster once the setting is on", () => {
		AgentRegistry.global().register({
			id: "Scout",
			displayName: "scout",
			kind: "sub",
			session: null,
			status: "parked",
			model: "anthropic/claude-opus-4-8",
		});
		const dashboard = new AgentDashboard({ terminalHeight: 40, showModelBadge: true });

		expect(frameOf(dashboard)).toContain("claude-opus-4-8");
		dashboard.dispose();
	});
});
