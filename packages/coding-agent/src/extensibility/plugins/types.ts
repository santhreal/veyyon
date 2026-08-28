export interface PluginFeature {
	description?: string;
	default?: boolean;
	extensions?: string[];
	tools?: string[];
	hooks?: string[];
	commands?: string[];
}

export interface PluginManifest {
	name?: string;
	version: string;
	description?: string;

	tools?: string;
	hooks?: string;
	extensions?: string[];
	commands?: string[];

	features?: Record<string, PluginFeature>;

	settings?: Record<string, PluginSettingSchema>;
}

export type PluginSettingType = "string" | "number" | "boolean" | "enum";

interface PluginSettingBase {
	type: PluginSettingType;
	description?: string;
	secret?: boolean;
	env?: string;
}

export interface StringSetting extends PluginSettingBase {
	type: "string";
	default?: string;
}

export interface NumberSetting extends PluginSettingBase {
	type: "number";
	default?: number;
	min?: number;
	max?: number;
	step?: number;
}

export interface BooleanSetting extends PluginSettingBase {
	type: "boolean";
	default?: boolean;
}

export interface EnumSetting extends PluginSettingBase {
	type: "enum";
	values: string[];
	default?: string;
}

export type PluginSettingSchema = StringSetting | NumberSetting | BooleanSetting | EnumSetting;

export interface InstalledPlugin {
	name: string;
	version: string;
	path: string;
	manifest: PluginManifest;
	enabledFeatures: string[] | null;
	enabled: boolean;
}

export interface PluginRuntimeState {
	version: string;
	enabledFeatures: string[] | null;
	enabled: boolean;
}

export interface PluginRuntimeConfig {
	plugins: Record<string, PluginRuntimeState>;
	settings: Record<string, Record<string, unknown>>;
}

export interface ProjectPluginOverrides {
	disabled?: string[];
	features?: Record<string, string[]>;
	settings?: Record<string, Record<string, unknown>>;
}

export interface DoctorCheck {
	name: string;
	status: "ok" | "warning" | "error";
	message: string;
	fixed?: boolean;
}

export interface InstallOptions {
	force?: boolean;
	dryRun?: boolean;
}

export interface DoctorOptions {
	fix?: boolean;
}
