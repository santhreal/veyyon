/** Discovery Module Auto-registers all providers by importing them. */
// Import capability definitions (ensures capabilities are defined before providers register)
import "../capability/context-file";
import "../capability/extension";
import "../capability/extension-module";
import "../capability/hook";
import "../capability/instruction";
import "../capability/mcp";
import "../capability/prompt";
import "../capability/rule";
import "../capability/skill";
import "../capability/slash-command";
import "../capability/ssh";
import "../capability/tool";
// Import providers (each registers itself on import)
import "./agents-md";
import "./builtin";
import "./builtin-defaults";
import "./claude";
import "./claude-plugins";
import "./agents";
import "./codex";
import "./cursor";
import "./gemini";
import "./opencode";
import "./github";
import "./veyyon-plugins";
import "./ssh";
import "./windsurf";

export {
	cacheStats,
	disableProvider,
	enableProvider,
	getAllCapabilitiesInfo,
	getAllProvidersInfo,
	getCapability,
	getCapabilityInfo,
	getDisabledProviders,
	getProviderInfo,
	initializeWithSettings,
	invalidate,
	isProviderEnabled,
	listCapabilities,
	loadCapability,
	reset,
	setDisabledProviders,
} from "../capability";
export type { ContextFile } from "../capability/context-file";
export type { ExtensionManifest, ManifestExtension } from "../capability/extension";
export type { ExtensionModule } from "../capability/extension-module";
export type { Hook } from "../capability/hook";
export type { Instruction } from "../capability/instruction";
export type { MCPServer } from "../capability/mcp";
export type { Prompt } from "../capability/prompt";
export type { Rule, RuleFrontmatter } from "../capability/rule";
export type { DiscoveredSkill, SkillFrontmatter } from "../capability/skill";
export type { SlashCommand } from "../capability/slash-command";
export type { SSHHost } from "../capability/ssh";
export type { DiscoveredCustomTool } from "../capability/tool";
export type * from "../capability/types";
