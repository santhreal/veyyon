/**
 * Plugin settings UI components.
 *
 * Provides a hierarchical settings interface:
 * - Plugin list (npm plugins)
 *   - npm plugin detail (enable/disable, features, config)
 */
import {
	Container,
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@veyyon/pi-tui";
import { logger } from "@veyyon/pi-utils";
import { PluginManager } from "../../extensibility/plugins/manager";
import type { InstalledPlugin, PluginSettingSchema } from "../../extensibility/plugins/types";
import { getSelectListTheme, getSettingsListTheme, theme } from "../../modes/theme/theme";
import { DynamicBorder } from "./dynamic-border";

/**
 * Forwards a keystroke to `input`, but cancels via `onCancel` when the user presses Escape.
 *
 * Escape is decoded via `matchesKey` rather than a raw `\x1b` compare: inside the
 * fullscreen settings overlay the kitty keyboard protocol is active (ghostty/kitty),
 * where the Escape key arrives as the CSI-u sequence `\x1b[27u`, not a bare `\x1b`.
 * The literal fallbacks preserve legacy single/double-escape on terminals without it.
 */
export function handleInputOrEscape(
	data: string,
	input: { handleInput(data: string): void },
	onCancel: () => void,
): void {
	if (data === "\x1b" || data === "\x1b\x1b" || matchesKey(data, "escape")) {
		onCancel();
		return;
	}
	input.handleInput(data);
}

// =============================================================================
// Plugin List Component
// =============================================================================

/**
 * One row in the plugin list.
 */
export type PluginListEntry = { kind: "npm"; plugin: InstalledPlugin };

export interface PluginListCallbacks {
	onNpmSelect: (plugin: InstalledPlugin) => void;
	onCancel: () => void;
}

/**
 * Shows installed npm plugins with enable/disable status and feature counts.
 */
export class PluginListComponent extends Container {
	readonly #selectList: SelectList;

	constructor(
		private readonly entries: ReadonlyArray<PluginListEntry>,
		callbacks: PluginListCallbacks,
	) {
		super();

		// Title
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "  Plugins")), 0, 0));
		this.addChild(new Spacer(1));

		if (entries.length === 0) {
			this.addChild(new Text(theme.fg("muted", "  No plugins installed"), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "  Install npm plugins: veyyon plugin install <package>"), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(new DynamicBorder());

			// Empty list still handles Escape so the user can leave the panel.
			this.#selectList = new SelectList([], 1, getSelectListTheme());
			this.#selectList.onCancel = callbacks.onCancel;
			return;
		}

		const items: SelectItem[] = entries.map(entry => this.#renderItem(entry));

		// npm plugin names can be long; widen the primary column for readability.
		this.#selectList = new SelectList(items, Math.min(items.length, 8), getSelectListTheme(), {
			minPrimaryColumnWidth: 24,
			maxPrimaryColumnWidth: 64,
		});

		this.#selectList.onSelect = item => {
			const found = findEntryByValue(this.entries, item.value);
			if (!found) return;
			callbacks.onNpmSelect(found.plugin);
		};

		this.#selectList.onCancel = callbacks.onCancel;

		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to configure · Esc to go back"), 0, 0));
		this.addChild(new DynamicBorder());
	}

	#renderItem(entry: PluginListEntry): SelectItem {
		const kindBadge = theme.fg("dim", "[npm]");
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

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}
}

function entryValue(entry: PluginListEntry): string {
	return `npm:${entry.plugin.name}`;
}

function findEntryByValue(entries: ReadonlyArray<PluginListEntry>, value: string): PluginListEntry | undefined {
	return entries.find(e => entryValue(e) === value);
}

// =============================================================================
// Plugin Detail Component
// =============================================================================

export interface PluginDetailCallbacks {
	onEnabledChange: (enabled: boolean) => void;
	onFeatureChange: (feature: string, enabled: boolean) => void;
	onConfigChange: (key: string, value: unknown) => void;
	onBack: () => void;
}

/**
 * Shows detail settings for a single plugin:
 * - Enable/disable toggle
 * - Feature toggles
 * - Config settings
 */
export class PluginDetailComponent extends Container {
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

		// Header
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", `  ${plugin.name}`)), 0, 0));
		if (manifest.description) {
			this.addChild(new Text(theme.fg("muted", `  ${manifest.description}`), 0, 0));
		}
		this.addChild(new Spacer(1));

		const items: SettingItem[] = [];

		// Enable/disable toggle
		items.push({
			id: "__enabled__",
			label: "Enabled",
			description: "Enable or disable this plugin",
			currentValue: plugin.enabled ? "true" : "false",
			values: ["true", "false"],
		});

		// Feature toggles
		if (manifest.features && Object.keys(manifest.features).length > 0) {
			const enabledSet = new Set(plugin.enabledFeatures ?? []);
			const defaultFeatures = Object.entries(manifest.features)
				.filter(([_, f]) => f.default)
				.map(([name]) => name);

			// If enabledFeatures is null, use defaults
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

		// Config settings
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
					// string or number - show as submenu with input
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
					// Update local state
					const current = new Set(this.plugin.enabledFeatures ?? []);
					if (newValue === "true") {
						current.add(featName);
					} else {
						current.delete(featName);
					}
					this.plugin = { ...this.plugin, enabledFeatures: [...current] };
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
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to edit · Esc to go back"), 0, 0));
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		if (!this.#settingsList) return;
		this.#settingsList.handleInput(data);
	}
}

// =============================================================================
// Config Submenus
// =============================================================================

/**
 * Submenu for enum config values.
 */
class ConfigEnumSubmenu extends Container {
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
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to cancel"), 0, 0));
	}

	handleInput(data: string): void {
		this.#selectList.handleInput(data);
	}
}

/**
 * Submenu for string/number config values with text input.
 */
class ConfigInputSubmenu extends Container {
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

		// Type hint
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

		// Input field
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
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to cancel"), 0, 0));
	}

	handleInput(data: string): void {
		handleInputOrEscape(data, this.#input, this.onCancel);
	}
}

// =============================================================================
// Main Plugin Settings Selector
// =============================================================================

export interface PluginSettingsCallbacks {
	onClose: () => void;
	onPluginChanged: () => void | Promise<void>;
}

/** Component with handleInput method */
interface InputHandler {
	handleInput(data: string): void;
}

/**
 * Top-level plugin settings component.
 * Manages navigation between plugin list and plugin detail views.
 */
export class PluginSettingsComponent extends Container {
	#manager: PluginManager;
	#viewComponent: (Container & InputHandler) | null = null;
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: state tracking for view management
	#currentView: "list" | "npm-detail" = "list";
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: state tracking for view management
	#currentPlugin: InstalledPlugin | null = null;

	constructor(
		cwd: string,
		private readonly callbacks: PluginSettingsCallbacks,
	) {
		super();
		this.#manager = new PluginManager(cwd);
		this.#showPluginList();
	}

	async #showPluginList(): Promise<void> {
		this.#currentView = "list";
		this.#currentPlugin = null;
		this.clear();

		const npmPlugins = await this.#manager.list().catch(err => {
			logger.error("Settings → Plugins: failed to list npm plugins", {
				error: err instanceof Error ? err.message : String(err),
			});
			return [] as InstalledPlugin[];
		});

		const entries: PluginListEntry[] = npmPlugins.map(plugin => ({ kind: "npm" as const, plugin }));

		this.#viewComponent = new PluginListComponent(entries, {
			onNpmSelect: plugin => this.#showPluginDetail(plugin),
			onCancel: () => this.callbacks.onClose(),
		});

		this.addChild(this.#viewComponent);
	}

	#showPluginDetail(plugin: InstalledPlugin): void {
		this.#currentView = "npm-detail";
		this.#currentPlugin = plugin;
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
				await this.#manager.setEnabledFeatures(plugin.name, [...current]);
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

	handleInput(data: string): void {
		if (!this.#viewComponent) {
			// The list view mounts asynchronously. Until it does, Escape must still close the panel.
			if (data === "\x1b" || data === "\x1b\x1b") {
				this.callbacks.onClose();
			}
			return;
		}
		this.#viewComponent.handleInput(data);
	}
}
