import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { agentsSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/agents";
import type {
	SetupSceneHost,
	SetupSceneResult,
	SetupWizardContext,
} from "@veyyon/coding-agent/modes/setup-wizard/scenes/types";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";

const agents: AgentDefinition[] = [
	{ name: "scout", description: "Explore code without editing", systemPrompt: "", source: "bundled", tools: ["read"] },
	{ name: "task", description: "Implement multi-step changes", systemPrompt: "", source: "bundled" },
	{
		name: "reviewer",
		description: "Review code and report findings",
		systemPrompt: "",
		source: "bundled",
		tools: ["read", "grep", "bash"],
	},
];

function host(settings: Settings): { host: SetupSceneHost; finished: Promise<SetupSceneResult> } {
	const completion = Promise.withResolvers<SetupSceneResult>();
	const ctx = {
		settings,
		session: { cwd: "/tmp" },
		ui: { invalidate() {} },
		openInBrowser() {},
		playWelcomeIntro() {},
		showError() {},
	} as unknown as SetupWizardContext;
	return {
		host: {
			ctx,
			requestRender() {},
			finish: completion.resolve,
			setFocus() {},
			restoreFocus() {},
		},
		finished: completion.promise,
	};
}

beforeEach(async () => {
	await initTheme(false, "unicode", false, "titanium", "light");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("setup wizard subagent selection", () => {
	/** A fresh profile starts with exactly the task worker checked and every specialist opt-in. */
	it("renders task enabled by default and specialists disabled", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
		const settings = Settings.isolated({ "subagent.agents": {} });
		const { host: sceneHost } = host(settings);
		expect(await agentsSetupScene.shouldRun?.(sceneHost.ctx)).toBe(true);
		const controller = agentsSetupScene.mount(sceneHost);
		const rendered = controller.render(100).join("\n");
		expect(rendered).toContain(`${theme.checkbox.checked} task`);
		expect(rendered).toContain(`${theme.checkbox.unchecked} reviewer`);
		expect(rendered).toContain(`${theme.checkbox.unchecked} scout`);
	});

	/** Choosing scout persists explicit per-agent permissions while leaving reviewer disabled. */
	it("persists the onboarding selection into the shared agents table", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
		const settings = Settings.isolated({ "subagent.agents": {} });
		const setup = host(settings);
		await agentsSetupScene.shouldRun?.(setup.host.ctx);
		const controller = agentsSetupScene.mount(setup.host);
		// Sorted rows are task, reviewer, scout, then Continue.
		const handleInput = controller.handleInput?.bind(controller);
		expect(handleInput).toBeDefined();
		if (!handleInput) throw new Error("subagent setup scene must accept keyboard input");
		handleInput("\x1b[B");
		handleInput("\x1b[B");
		handleInput(" ");
		handleInput("\x1b[B");
		handleInput("\r");
		expect(await setup.finished).toBe("done");
		expect(settings.get("subagent.agents")).toEqual({
			reviewer: { enabled: false },
			scout: { enabled: true },
			task: { enabled: true },
		});
	});
});
