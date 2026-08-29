import { Input, type SelectItem, SelectList, type SettingItem, SettingsList, Spacer, Text } from "@veyyon/tui";
import { errorMessage, logger } from "@veyyon/utils";
import { PluginManager } from "../../extensibility/plugins/manager";
import type { InstalledPluginSummary, MarketplaceManager } from "../../extensibility/plugins/marketplace";
import type { InstalledPlugin, PluginSettingSchema } from "../../extensibility/plugins/types";
import { getSelectListTheme, getSettingsListTheme, theme } from "../../modes/theme/theme";
import { shortenPath } from "../../tools/render-utils";
import { type ModalShortcut, SETTINGS_SUBPANE_SHORTCUTS } from "./modal-shell";
import type { PluginListCallbacks, PluginListEntry } from "./plugin-settings-helpers";

import {
	entryValue,
	findEntryByValue,
	handleInputOrEscape,
	MARKETPLACE_DETAIL_SHORTCUTS,
	marketplaceEnabled,
	PLUGIN_DETAIL_SHORTCUTS,
	PLUGIN_LIST_SHORTCUTS,
} from "./plugin-settings-helpers";
import { MouseRoutedSubmenu, type TrackedMouseTarget } from "./select-list-mouse-routing";

export type { PluginListEntry };
export { handleInputOrEscape };

export class PluginListComponent extends MouseRoutedSubmenu {
	readonly #selectList: SelectList;

	constructor(
		private readonly entries: ReadonlyArray<PluginListEntry>,
		callbacks: PluginListCallbacks,
	) {
		super();

		this.addChild(new Text(theme.bold(theme.fg("accent", "  Plugins")), 0, 0));
		this.addChild(new Spacer(1));

		if (entries.length === 0) {
			this.addChild(new Text(theme.fg("muted", "  No plugins installed"), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(
				new Text(theme.fg("dim", "  Install npm plugins:        veyyon plugin install <package>"), 0, 0),
			);
			this.addChild(
				new Text(
					theme.fg("dim", "  Install marketplace plugins: veyyon plugin install <name>@<marketplace>"),
					0,
					0,
				),
			);

			this.#selectList = new SelectList([], 1, getSelectListTheme());
			this.#selectList.onCancel = callbacks.onCancel;
			return;
		}

		const items: SelectItem[] = entries.map(entry => this.#renderItem(entry));

		this.#selectList = new SelectList(items, Math.min(items.length, 8), getSelectListTheme(), {
			minPrimaryColumnWidth: 24,
			maxPrimaryColumnWidth: 64,
		});

		this.#selectList.onSelect = item => {
			const found = findEntryByValue(this.entries, item.value);
			if (!found) return;
			if (found.kind === "npm") callbacks.onNpmSelect(found.plugin);
			else callbacks.onMarketplaceSelect(found.plugin);
		};

		this.#selectList.onCancel = callbacks.onCancel;

		this.addChild(this.#selectList);
	}

	#renderItem(entry: PluginListEntry): SelectItem {
		const kindBadge = theme.fg("dim", entry.kind === "npm" ? "[npm]" : "[marketplace]");

		if (entry.kind === "npm") {
			const p = entry.plugin;
			const status = p.enabled
				? theme.fg("success", theme.status.enabled)
				: theme.fg("muted", theme.status.disabled);
			const featureCount = p.manifest.features ? Object.keys(p.manifest.features).length : 0;
			const enabledCount = p.enabledFeatures?.length ?? featureCount;

			let details = `${kindBadge} ${theme.sep.dot} v${p.version}`;
			if (featureCount > 0) {
				details += ` ${theme.sep.dot} ${enabledCount}/${featureCount} features`;
			}

			return {
				value: entryValue(entry),
				label: `${status} ${p.name}`,
				description: details,
			};
		}

		const summary = entry.plugin;
		const enabled = marketplaceEnabled(summary);
		const status = enabled ? theme.fg("success", theme.status.enabled) : theme.fg("muted", theme.status.disabled);
		const scopeTag = theme.fg("dim", `[${summary.scope}]`);
		const shadowMarker = summary.shadowedBy ? ` ${theme.fg("warning", theme.status.shadowed)}` : "";
		const version = summary.entries[0]?.version ?? "?";

		let details = `${kindBadge} ${scopeTag} ${theme.sep.dot} v${version}`;
		if (summary.shadowedBy) {
			details += ` ${theme.sep.dot} shadowed by ${summary.shadowedBy}`;
		}

		return {
			value: entryValue(entry),
			label: `${status} ${summary.id}${shadowMarker}`,
			description: details,
		};
	}

	mouseTarget(): TrackedMouseTarget {
		return this.#selectList;
	}

	shortcuts(): readonly ModalShortcut[] {
		return PLUGIN_LIST_SHORTCUTS;
	}

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}
}

export interface PluginDetailCallbacks {
	onEnabledChange: (enabled: boolean) => void;
	onFeatureChange: (feature: string, enabled: boolean) => void;
	onConfigChange: (key: string, value: unknown) => void;
	onBack: () => void;
}

export class PluginDetailComponent extends MouseRoutedSubmenu {
	#settingsList!: SettingsList;

	constructor(
		private plugin: InstalledPlugin,
		private readonly manager: PluginManager,
		private readonly callbacks: PluginDetailCallbacks,
	) {
		super();

		void this.#rebuild();
	}

	async #rebuild(): Promise<void> {
		this.clear();

		const plugin = this.plugin;
		const manifest = plugin.manifest;

		this.addChild(new Text(theme.bold(theme.fg("accent", `  ${plugin.name}`)), 0, 0));
		if (manifest.description) {
			this.addChild(new Text(theme.fg("muted", `  ${manifest.description}`), 0, 0));
		}
		this.addChild(new Spacer(1));

		const items: SettingItem[] = [];

		items.push({
			id: "__enabled__",
			label: "Enabled",
			description: "Enable or disable this plugin",
			currentValue: plugin.enabled ? "true" : "false",
			values: ["true", "false"],
		});

		if (manifest.features && Object.keys(manifest.features).length > 0) {
			const enabledSet = new Set(plugin.enabledFeatures ?? []);
			const defaultFeatures = Object.entries(manifest.features)
				.filter(([_, f]) => f.default)
				.map(([name]) => name);

			const effectiveEnabled = plugin.enabledFeatures === null ? new Set(defaultFeatures) : enabledSet;

			for (const [featName, feat] of Object.entries(manifest.features)) {
				const isEnabled = effectiveEnabled.has(featName);
				items.push({
					id: `feature:${featName}`,
					label: `  ${featName}`,
					description: feat.description || `Enable ${featName} feature`,
					currentValue: isEnabled ? "true" : "false",
					values: ["true", "false"],
				});
			}
		}

		if (manifest.settings && Object.keys(manifest.settings).length > 0) {
			const settings = await this.manager.getPluginSettings(plugin.name);

			for (const [key, schema] of Object.entries(manifest.settings)) {
				const currentValue = settings[key] ?? schema.default;
				const displayValue = schema.secret && currentValue ? "••••••••" : String(currentValue ?? "(not set)");

				if (schema.type === "boolean") {
					items.push({
						id: `config:${key}`,
						label: `  ${key}`,
						description: schema.description || `Configure ${key}`,
						currentValue: currentValue ? "true" : "false",
						values: ["true", "false"],
					});
				} else if (schema.type === "enum") {
					items.push({
						id: `config:${key}`,
						label: `  ${key}`,
						description: schema.description || `Configure ${key}`,
						currentValue: String(currentValue ?? schema.default ?? ""),
						submenu: (cv, done) =>
							new ConfigEnumSubmenu(
								key,
								schema.description || `Select value for ${key}`,
								schema.values,
								cv,
								value => {
									this.callbacks.onConfigChange(key, value);
									done(value);
								},
								() => done(),
							),
					});
				} else {
					items.push({
						id: `config:${key}`,
						label: `  ${key}`,
						description: schema.description || `Configure ${key}`,
						currentValue: displayValue,
						submenu: (cv, done) =>
							new ConfigInputSubmenu(
								key,
								schema,
								cv === "(not set)" ? "" : cv,
								value => {
									const parsed = schema.type === "number" ? Number(value) : value;
									this.callbacks.onConfigChange(key, parsed);
									done(String(value));
								},
								() => done(),
							),
					});
				}
			}
		}

		this.#settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				if (id === "__enabled__") {
					this.callbacks.onEnabledChange(newValue === "true");
					this.plugin = { ...this.plugin, enabled: newValue === "true" };
				} else if (id.startsWith("feature:")) {
					const featName = id.slice(8);
					this.callbacks.onFeatureChange(featName, newValue === "true");
					const current = new Set(this.plugin.enabledFeatures ?? []);
					if (newValue === "true") {
						current.add(featName);
					} else {
						current.delete(featName);
					}
					this.plugin = { ...this.plugin, enabledFeatures: Array.from(current) };
				} else if (id.startsWith("config:")) {
					const key = id.slice(7);
					const schema = this.plugin.manifest.settings?.[key];
					if (schema?.type === "boolean") {
						this.callbacks.onConfigChange(key, newValue === "true");
					}
				}
			},
			this.callbacks.onBack,
		);

		this.addChild(this.#settingsList);
	}

	mouseTarget(): TrackedMouseTarget | undefined {
		return this.#settingsList;
	}

	shortcuts(): readonly ModalShortcut[] {
		if (this.#settingsList?.hasOpenSubmenu()) return SETTINGS_SUBPANE_SHORTCUTS;
		return PLUGIN_DETAIL_SHORTCUTS;
	}

	handleInput(data: string): void {
		if (!this.#settingsList) return;
		this.#settingsList.handleInput(data);
	}
}

export interface MarketplacePluginDetailCallbacks {
	onEnabledChange: (enabled: boolean) => void;
	onBack: () => void;
}

export class MarketplacePluginDetailComponent extends MouseRoutedSubmenu {
	#settingsList: SettingsList;

	constructor(
		private plugin: InstalledPluginSummary,
		private readonly callbacks: MarketplacePluginDetailCallbacks,
	) {
		super();

		const entry = plugin.entries[0];
		const enabled = marketplaceEnabled(plugin);

		this.addChild(new Text(theme.bold(theme.fg("accent", `  ${plugin.id}`)), 0, 0));

		const subtitleParts = [`[${plugin.scope}]`];
		if (plugin.shadowedBy) subtitleParts.push(`${theme.status.shadowed} shadowed by ${plugin.shadowedBy}`);
		this.addChild(new Text(theme.fg("muted", `  ${subtitleParts.join(" ")}`), 0, 0));
		this.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "__enabled__",
				label: "Enabled",
				description: "Enable or disable this marketplace plugin",
				currentValue: enabled ? "true" : "false",
				values: ["true", "false"],
			},
		];

		this.#settingsList = new SettingsList(
			items,
			items.length,
			getSettingsListTheme(),
			(id, newValue) => {
				if (id === "__enabled__") {
					const next = newValue === "true";
					this.callbacks.onEnabledChange(next);
					this.plugin = {
						...this.plugin,
						entries: this.plugin.entries.map(e => ({ ...e, enabled: next })),
					};
				}
			},
			this.callbacks.onBack,
		);

		this.addChild(this.#settingsList);
		this.addChild(new Spacer(1));

		this.addChild(new Text(theme.fg("dim", `  version       ${entry?.version ?? "(unknown)"}`), 0, 0));
		this.addChild(new Text(theme.fg("dim", `  scope         ${plugin.scope}`), 0, 0));
		this.addChild(
			new Text(
				theme.fg("dim", `  install path  ${entry?.installPath ? shortenPath(entry.installPath) : "(unknown)"}`),
				0,
				0,
			),
		);
		this.addChild(new Text(theme.fg("dim", `  installed at  ${entry?.installedAt ?? "(unknown)"}`), 0, 0));
		this.addChild(new Text(theme.fg("dim", `  last updated  ${entry?.lastUpdated ?? "(unknown)"}`), 0, 0));
		if (entry?.gitCommitSha) {
			this.addChild(new Text(theme.fg("dim", `  git sha       ${entry.gitCommitSha}`), 0, 0));
		}
	}

	mouseTarget(): TrackedMouseTarget {
		return this.#settingsList;
	}

	shortcuts(): readonly ModalShortcut[] {
		return MARKETPLACE_DETAIL_SHORTCUTS;
	}

	handleInput(data: string): void {
		this.#settingsList.handleInput(data);
	}
}

class ConfigEnumSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList;

	constructor(
		key: string,
		description: string,
		values: string[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
	) {
		super();

		this.addChild(new Text(theme.bold(theme.fg("accent", key)), 0, 0));
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}
		this.addChild(new Spacer(1));

		const items: SelectItem[] = values.map(v => ({ value: v, label: v }));
		this.#selectList = new SelectList(items, Math.min(items.length, 8), getSelectListTheme());

		const currentIndex = values.indexOf(currentValue);
		if (currentIndex !== -1) {
			this.#selectList.setSelectedIndex(currentIndex);
		}

		this.#selectList.onSelect = item => onSelect(item.value);
		this.#selectList.onCancel = onCancel;

		this.addChild(this.#selectList);
	}

	mouseTarget(): TrackedMouseTarget {
		return this.#selectList;
	}

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}
}

class ConfigInputSubmenu extends MouseRoutedSubmenu {
	#input: Input;

	constructor(
		key: string,
		schema: PluginSettingSchema,
		currentValue: string,
		private readonly onSubmit: (value: string) => void,
		private readonly onCancel: () => void,
	) {
		super();

		this.addChild(new Text(theme.bold(theme.fg("accent", key)), 0, 0));
		if (schema.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", schema.description), 0, 0));
		}

		let hint = `Type: ${schema.type}`;
		if (schema.type === "number") {
			const numSchema = schema as { min?: number; max?: number };
			if (numSchema.min !== undefined || numSchema.max !== undefined) {
				hint += ` (${numSchema.min ?? ""}..${numSchema.max ?? ""})`;
			}
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", hint), 0, 0));

		this.addChild(new Spacer(1));

		this.#input = new Input();
		if (!schema.secret && currentValue) {
			this.#input.setValue(currentValue);
		}

		this.#input.onSubmit = value => {
			if (value.trim()) {
				this.onSubmit(value);
			} else {
				this.onCancel();
			}
		};

		this.addChild(this.#input);
	}

	mouseTarget(): TrackedMouseTarget | undefined {
		return undefined;
	}

	handleInput(data: string): void {
		handleInputOrEscape(data, this.#input, this.onCancel);
	}
}

export interface PluginSettingsCallbacks {
	onClose: () => void;
	onPluginChanged: () => void | Promise<void>;
}

interface PluginView extends MouseRoutedSubmenu {
	handleInput(data: string): void;
	shortcuts(): readonly ModalShortcut[];
}

export class PluginSettingsComponent extends MouseRoutedSubmenu {
	#cwd: string;
	#manager: PluginManager;
	#viewComponent: PluginView | null = null;

	constructor(
		cwd: string,
		private readonly callbacks: PluginSettingsCallbacks,
	) {
		super();
		this.#cwd = cwd;
		this.#manager = new PluginManager(cwd);
		this.#showPluginList();
	}

	async #buildMarketplaceManager(): Promise<MarketplaceManager> {
		const { createMarketplaceManager } = await import("../../extensibility/plugins/marketplace/factory");
		return createMarketplaceManager(this.#cwd);
	}

	async #showPluginList(): Promise<void> {
		this.clear();

		const [npmPlugins, marketplacePlugins] = await Promise.all([
			this.#manager.list().catch(err => {
				logger.error("Settings → Plugins: failed to list npm plugins", {
					error: errorMessage(err),
				});
				return [] as InstalledPlugin[];
			}),
			this.#buildMarketplaceManager()
				.then(mgr => mgr.listInstalledPlugins())
				.catch(err => {
					logger.error("Settings → Plugins: failed to list marketplace plugins", {
						error: errorMessage(err),
					});
					return [] as InstalledPluginSummary[];
				}),
		]);

		const entries: PluginListEntry[] = [
			...npmPlugins.map(plugin => ({ kind: "npm" as const, plugin })),
			...marketplacePlugins.map(plugin => ({ kind: "marketplace" as const, plugin })),
		];

		this.#viewComponent = new PluginListComponent(entries, {
			onNpmSelect: plugin => this.#showPluginDetail(plugin),
			onMarketplaceSelect: plugin => this.#showMarketplaceDetail(plugin),
			onCancel: () => this.callbacks.onClose(),
		});

		this.addChild(this.#viewComponent);
	}

	#showPluginDetail(plugin: InstalledPlugin): void {
		this.clear();

		this.#viewComponent = new PluginDetailComponent(plugin, this.#manager, {
			onEnabledChange: async enabled => {
				await this.#manager.setEnabled(plugin.name, enabled);
				await this.callbacks.onPluginChanged();
			},
			onFeatureChange: async (feature, enabled) => {
				const current = new Set((await this.#manager.getEnabledFeatures(plugin.name)) ?? []);
				if (enabled) {
					current.add(feature);
				} else {
					current.delete(feature);
				}
				await this.#manager.setEnabledFeatures(plugin.name, Array.from(current));
				await this.callbacks.onPluginChanged();
			},
			onConfigChange: async (key, value) => {
				await this.#manager.setPluginSetting(plugin.name, key, value);
				await this.callbacks.onPluginChanged();
			},
			onBack: () => this.#showPluginList(),
		});

		this.addChild(this.#viewComponent);
	}

	#showMarketplaceDetail(plugin: InstalledPluginSummary): void {
		this.clear();

		this.#viewComponent = new MarketplacePluginDetailComponent(plugin, {
			onEnabledChange: async enabled => {
				try {
					const mgr = await this.#buildMarketplaceManager();
					await mgr.setPluginEnabled(plugin.id, enabled, plugin.scope);
					await this.callbacks.onPluginChanged();
				} catch (err) {
					logger.error("Settings → Plugins: failed to toggle marketplace plugin", {
						pluginId: plugin.id,
						scope: plugin.scope,
						enabled,
						error: errorMessage(err),
					});
				}
			},
			onBack: () => this.#showPluginList(),
		});

		this.addChild(this.#viewComponent);
	}

	mouseTarget(): TrackedMouseTarget | undefined {
		return this.#viewComponent ?? undefined;
	}

	shortcuts(): readonly ModalShortcut[] {
		return this.#viewComponent?.shortcuts() ?? PLUGIN_LIST_SHORTCUTS;
	}

	handleInput(data: string): void {
		if (!this.#viewComponent) {
			if (data === "\x1b" || data === "\x1b\x1b") {
				this.callbacks.onClose();
			}
			return;
		}
		this.#viewComponent.handleInput(data);
	}
}
