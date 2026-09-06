import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { AgentsSceneController } from "../src/modes/setup-wizard/scenes/agents";
import { approvalsSetupScene } from "../src/modes/setup-wizard/scenes/approvals";
import { glyphSetupScene } from "../src/modes/setup-wizard/scenes/glyph";
import { ImportSceneController } from "../src/modes/setup-wizard/scenes/import";
import { renderSetupOutro } from "../src/modes/setup-wizard/scenes/outro";
import { renderSetupSplash } from "../src/modes/setup-wizard/scenes/splash";
import { themeSetupScene } from "../src/modes/setup-wizard/scenes/theme";
import type { SetupSceneHost, SetupSceneResult, SetupWizardContext } from "../src/modes/setup-wizard/scenes/types";
import { WebSearchTab } from "../src/modes/setup-wizard/scenes/web-search";
import { initTheme } from "../src/modes/theme/theme";
import { useTempHome } from "./helpers/temp-home";

useTempHome();

const WIDTHS = [60, 100, 160] as const;
const HEIGHTS = [12, 24] as const;
const KEYS = [
	{ name: "Tab", input: "\t" },
	{ name: "Shift-Tab", input: "\x1b[Z" },
	{ name: "Esc", input: "\x1b" },
	{ name: "Enter", input: "\r" },
	{ name: "Space", input: " " },
	{ name: "Up", input: "\x1b[A" },
	{ name: "Down", input: "\x1b[B" },
] as const;

function createMockHost(): {
	host: SetupSceneHost;
	finished: SetupSceneResult[];
	skipped: boolean;
	renders: number;
} {
	const finished: SetupSceneResult[] = [];
	let skipped = false;
	let renders = 0;

	const ctx = {
		settings: Settings.isolated(),
		session: {
			modelRegistry: {
				authStorage: { hasAuth: () => false, has: () => false, getCredentialOrigin: () => undefined },
				getAvailable: () => [],
			},
		},
		openInBrowser: () => {},
		showError: () => {},
		ui: { terminal: { rows: 24 }, setFocus: () => {}, requestRender: () => {}, invalidate: () => {} },
	} as unknown as SetupWizardContext;

	const host: SetupSceneHost = {
		ctx,
		requestRender: () => {
			renders++;
		},
		finish: (result: SetupSceneResult) => {
			finished.push(result);
		},
		skipSetup: () => {
			skipped = true;
		},
		setFocus: () => {},
		restoreFocus: () => {},
	};

	return { host, finished, skipped, renders };
}

describe("Setup wizard scenes at multiple dimensions and inputs", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});

	describe("splash scene (welcome)", () => {
		for (const w of WIDTHS) {
			for (const h of HEIGHTS) {
				it(`renders splash at ${w}x${h}`, () => {
					const lines = renderSetupSplash(w, h, 500);
					expect(lines.length).toBe(h);
					for (const line of lines) {
						// Strip ANSI and verify width
						const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
						expect(stripped.length).toBe(w);
						expect(line).not.toContain("undefined");
						expect(line).not.toContain("NaN");
					}
				});
			}
		}
	});

	describe("outro scene (done)", () => {
		for (const w of WIDTHS) {
			for (const h of HEIGHTS) {
				it(`renders outro at ${w}x${h}`, () => {
					const lines = renderSetupOutro(w, h, 800);
					expect(lines.length).toBe(h);
					for (const line of lines) {
						const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
						expect(stripped.length).toBe(w);
						expect(line).not.toContain("undefined");
						expect(line).not.toContain("NaN");
					}
				});
			}
		}
	});

	describe("theme scene", () => {
		for (const w of WIDTHS) {
			for (const h of HEIGHTS) {
				it(`renders theme scene at ${w}x${h} and handles keys`, () => {
					const { host } = createMockHost();
					const controller = themeSetupScene.mount(host);

					const initialLines = controller.render(w, h);
					expect(initialLines.length).toBeLessThanOrEqual(h);
					for (const line of initialLines) {
						expect(line).not.toContain("undefined");
						expect(line).not.toContain("NaN");
					}

					// Exercise inputs
					for (const key of KEYS) {
						controller.handleInput?.(key.input);
						const frame = controller.render(w, h);
						expect(frame.length).toBeLessThanOrEqual(h);
					}

					controller.dispose?.();
				});
			}
		}
	});

	describe("glyph scene (symbols / keybindings)", () => {
		for (const w of WIDTHS) {
			for (const h of HEIGHTS) {
				it(`renders glyph scene at ${w}x${h} and handles keys`, () => {
					const { host } = createMockHost();
					const controller = glyphSetupScene.mount(host);

					const initialLines = controller.render(w, h);
					expect(initialLines.length).toBeLessThanOrEqual(h);
					for (const line of initialLines) {
						expect(line).not.toContain("undefined");
						expect(line).not.toContain("NaN");
					}

					for (const key of KEYS) {
						controller.handleInput?.(key.input);
						const frame = controller.render(w, h);
						expect(frame.length).toBeLessThanOrEqual(h);
					}

					controller.dispose?.();
				});
			}
		}
	});

	describe("approvals scene", () => {
		for (const w of WIDTHS) {
			for (const h of HEIGHTS) {
				it(`renders approvals scene at ${w}x${h} and handles keys`, () => {
					const { host } = createMockHost();
					const controller = approvalsSetupScene.mount(host);

					const initialLines = controller.render(w, h);
					expect(initialLines.length).toBeLessThanOrEqual(h);
					for (const line of initialLines) {
						expect(line).not.toContain("undefined");
						expect(line).not.toContain("NaN");
					}

					for (const key of KEYS) {
						controller.handleInput?.(key.input);
						const frame = controller.render(w, h);
						expect(frame.length).toBeLessThanOrEqual(h);
					}

					controller.dispose?.();
				});
			}
		}
	});

	describe("import scene", () => {
		for (const w of WIDTHS) {
			for (const h of HEIGHTS) {
				it(`renders import scene at ${w}x${h} and handles keys`, () => {
					const { host } = createMockHost();
					const controller = new ImportSceneController(host, [
						{
							kind: "skill",
							name: "test-skill",
							providerName: "Claude Code",
							sourcePath: "/home/user/.claude/skills/test-skill.md",
						},
					]);

					const initialLines = controller.render(w, h);
					expect(initialLines.length).toBeLessThanOrEqual(h);
					for (const line of initialLines) {
						expect(line).not.toContain("undefined");
						expect(line).not.toContain("NaN");
					}

					for (const key of KEYS) {
						controller.handleInput?.(key.input);
						const frame = controller.render(w, h);
						expect(frame.length).toBeLessThanOrEqual(h);
					}
				});
			}
		}
	});

	describe("agents scene", () => {
		for (const w of WIDTHS) {
			for (const h of HEIGHTS) {
				it(`renders agents scene at ${w}x${h} and handles keys`, () => {
					const { host } = createMockHost();
					const controller = new AgentsSceneController(host, [
						{
							name: "scout",
							description: "Fast read-only codebase explorer",
							systemPrompt: "You are scout",
							tools: ["read", "search"],
							source: "bundled",
						},
						{
							name: "reviewer",
							description: "Code reviewer inspecting diffs",
							systemPrompt: "You are reviewer",
							tools: ["read"],
							source: "bundled",
						},
					]);

					const initialLines = controller.render(w, h);
					expect(initialLines.length).toBeLessThanOrEqual(h);
					for (const line of initialLines) {
						expect(line).not.toContain("undefined");
						expect(line).not.toContain("NaN");
					}

					for (const key of KEYS) {
						controller.handleInput?.(key.input);
						const frame = controller.render(w, h);
						expect(frame.length).toBeLessThanOrEqual(h);
					}
				});
			}
		}
	});

	describe("web-search tab", () => {
		for (const w of WIDTHS) {
			for (const h of HEIGHTS) {
				it(`renders web-search tab at ${w}x${h} and handles keys`, () => {
					const { host } = createMockHost();
					const tab = new WebSearchTab(host);

					const initialLines = tab.render(w, h);
					expect(initialLines.length).toBeLessThanOrEqual(h);
					for (const line of initialLines) {
						expect(line).not.toContain("undefined");
						expect(line).not.toContain("NaN");
					}

					for (const key of KEYS) {
						tab.handleInput?.(key.input);
						const frame = tab.render(w, h);
						expect(frame.length).toBeLessThanOrEqual(h);
					}

					tab.dispose?.();
				});
			}
		}
	});
});
