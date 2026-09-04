import type { PluginManifest } from "@veyyon/plugin";

// =============================================================================
// Installed Plugin Types
// =============================================================================

/**
 * Represents an installed plugin with full metadata.
 */
export interface InstalledPlugin {
	/** npm package name */
	name: string;
	/** Installed version */
	version: string;
	/** Absolute path to package directory */
	path: string;
	/** Parsed veyyon (legacy omp/pi) manifest */
	manifest: PluginManifest;
	/**
	 * Enabled features:
	 * - null: use defaults (all features with default: true)
	 * - string[]: specific features enabled
	 */
	enabledFeatures: string[] | null;
	/** Whether the plugin is enabled */
	enabled: boolean;
}

// =============================================================================
// Runtime Config Types (stored in veyyon-plugins.lock.json)
// =============================================================================

/**
 * Per-plugin runtime state stored in lock file.
 */
export interface PluginRuntimeState {
	/** Installed version */
	version: string;
	/** Enabled features (null = defaults) */
	enabledFeatures: string[] | null;
	/** Whether the plugin is enabled */
	enabled: boolean;
}

/**
 * Runtime configuration persisted to veyyon-plugins.lock.json.
 * Tracks plugin states and settings across sessions.
 */
export interface PluginRuntimeConfig {
	/** Plugin states keyed by package name */
	plugins: Record<string, PluginRuntimeState>;
	/** Plugin settings keyed by package name, then setting key */
	settings: Record<string, Record<string, unknown>>;
}

// =============================================================================
// Project Override Types
// =============================================================================

/**
 * Project-local plugin overrides (stored in .veyyon/plugin-overrides.json).
 * Allows per-project plugin configuration without modifying global state.
 */
export interface ProjectPluginOverrides {
	/** Plugins to disable in this project */
	disabled?: string[];
	/** Per-plugin feature overrides */
	features?: Record<string, string[]>;
	/** Per-plugin setting overrides */
	settings?: Record<string, Record<string, unknown>>;
}

// =============================================================================
// Doctor Types
// =============================================================================

export interface DoctorCheck {
	/** Check identifier */
	name: string;
	/** Check result status */
	status: "ok" | "warning" | "error";
	/** Human-readable message */
	message: string;
	/** Whether --fix resolved this issue */
	fixed?: boolean;
}

// =============================================================================
// Install Options Types
// =============================================================================

export interface InstallOptions {
	/** Overwrite existing without prompting */
	force?: boolean;
	/** Preview changes without applying */
	dryRun?: boolean;
}

export interface DoctorOptions {
	/** Attempt automatic fixes */
	fix?: boolean;
}
