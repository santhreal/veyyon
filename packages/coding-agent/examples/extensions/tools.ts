import type { ExtensionAPI, ExtensionContext } from "@veyyon/coding-agent";
import { getSettingsListTheme } from "@veyyon/coding-agent";
import { Container, type SettingItem, SettingsList } from "@veyyon/tui";

interface ToolsState {
	enabledTools: string[];
}

export default function toolsExtension(pi: ExtensionAPI) {
	let enabledTools: Set<string> = new Set();
	let allTools: string[] = [];

	function persistState() {
		pi.appendEntry<ToolsState>("tools-config", {
			enabledTools: Array.from(enabledTools),
		});
	}

	async function applyTools() {
		await pi.setActiveTools(Array.from(enabledTools));
	}

	async function restoreFromBranch(ctx: ExtensionContext) {
		allTools = pi.getAllTools();

		const branchEntries = ctx.sessionManager.getBranch();
		let savedTools: string[] | undefined;

		for (const entry of branchEntries) {
			if (entry.type === "custom" && (entry as { customType?: string }).customType === "tools-config") {
				const data = (entry as { data?: ToolsState }).data;
				if (data?.enabledTools) {
					savedTools = data.enabledTools;
				}
			}
		}

		if (savedTools) {
			enabledTools = new Set(savedTools.filter((t: string) => allTools.includes(t)));
			await applyTools();
		} else {
			enabledTools = new Set(pi.getActiveTools());
		}
	}

	pi.registerCommand("tools", {
		description: "Enable/disable tools",
		handler: async (_args, ctx) => {
			allTools = pi.getAllTools();

			await ctx.ui.custom((tui, theme, _keybindings, done) => {
				const items: SettingItem[] = allTools.map(tool => ({
					id: tool,
					label: tool,
					currentValue: enabledTools.has(tool) ? "enabled" : "disabled",
					values: ["enabled", "disabled"],
				}));

				const container = new Container();
				const header: readonly string[] = [theme.fg("accent", theme.bold("Tool Configuration")), ""];
				container.addChild(
					new (class {
						render(_width: number): readonly string[] {
							return header;
						}
						invalidate() {}
					})(),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						if (newValue === "enabled") {
							enabledTools.add(id);
						} else {
							enabledTools.delete(id);
						}
						applyTools();
						persistState();
					},
					() => {
						done(undefined);
					},
				);

				container.addChild(settingsList);

				const component = {
					render(width: number): readonly string[] {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};

				return component;
			});
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await restoreFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restoreFromBranch(ctx);
	});

	pi.on("session_branch", async (_event, ctx) => {
		await restoreFromBranch(ctx);
	});
}
