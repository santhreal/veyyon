import { HookEditorComponent, HookInputComponent, HookSelectorComponent } from "./modes/terminal/components";

// Core session management

export * from "@veyyon/kernel/session/agent-session-compaction-policy";
// Auth and model registry
export * from "@veyyon/kernel/session/auth-storage";
export * from "@veyyon/kernel/session/indexed-session-storage";
export * from "@veyyon/kernel/session/redis-session-storage";
export * from "@veyyon/kernel/session/session-entries";
export * from "@veyyon/kernel/session/session-listing";
export * from "@veyyon/kernel/session/session-migrations";
export * from "@veyyon/kernel/session/session-storage";
export * from "@veyyon/kernel/session/sql-session-storage";
// Re-export TUI components for custom tool rendering
export { Container, Markdown, Spacer, Text } from "@veyyon/tui";
// Logging
export { getAgentDir, logger, VERSION } from "@veyyon/utils";
export * as zod from "zod/v4";
export { z } from "zod/v4";
export * from "./config/keybindings";
export * from "./config/model-registry";
// Prompt templates
export type * from "./config/prompt-templates";
export * from "./config/prompt-templates";
export type { RetrySettings, SkillsSettings } from "./config/settings";
export { Settings, settings } from "./config/settings";
// Tool implementation modules. These were re-exported through the tools
// barrel; they now live here so the CLI boot path (which never imports this
// library entry) can lazy-load tool implementations on first construction.
export * from "./edit";
// Custom commands
export type * from "./extensibility/custom-commands/types";
export type * from "./extensibility/custom-tools";
// Custom tools
export * from "./extensibility/custom-tools";
export type * from "./extensibility/extensions";
// Extension types and utilities
export * from "./extensibility/extensions";
// Hook system types. `HookAPI` is the type every hook file annotates its
// default export with, and every example and doc page imports it FROM HERE. The
// export line under this comment had been deleted, leaving the comment behind:
// `import type { HookAPI } from "@veyyon/coding-agent"` then failed to
// typecheck in all fifteen hook examples, and `examples/hooks/README.md` sent
// readers to `@veyyon/coding-agent/hooks`, a specifier that does not resolve.
// Named rather than `export type *`: the hook API deliberately mirrors the
// extension API, so eleven event-result type names are declared in both modules
// and a star re-export is ambiguous. These two are what a hook file needs.
export type { HookAPI, HookContext } from "./extensibility/hooks/types";
// Skills
export * from "./extensibility/skills";
export * from "./goals";
export type * from "./lsp";
export * from "./lsp";
// Main entry point
export * from "./main";
// Run modes for programmatic SDK usage
export * from "./modes";
export * from "./modes/terminal/components";
// SDK for programmatic usage
export * from "./sdk";
export {
	buildExpansionRecord,
	decodeLog,
	encodeRecord,
	MAX_RECORD_BYTES,
	placeholdersIn,
	ROTATE_AT_BYTES,
	ROTATED_SUFFIX,
	SECRET_AUDIT_FILENAME,
	SecretAuditLog,
	type SecretExpansionRecord,
	secretAuditPath,
} from "./secrets/audit";
export * from "./session/agent-session";
export * from "./session/agent-session-message-shapes";
export * from "./session/agent-session-permissions";
export * from "./session/agent-session-queue";
export * from "./session/agent-session-retry-fallback";
export * from "./session/agent-session-types";
export * from "./session/factory-extensions";
export * from "./session/factory-mcp";
export * from "./session/factory-notices";
export * from "./session/factory-options";
export * from "./session/factory-prompt";
export * from "./session/factory-tools";
export * from "./session/messages";
export * from "./session/session-context";
export * from "./session/session-dump-format";
export * from "./session/session-loader";
export * from "./session/session-manager";
export * from "./session/streaming-output";
export * from "./task";
export * from "./task/executor";
export type * from "./task/types";
// Theme utilities for custom tools
export * from "./theme/theme";
// Tools (detail types and utilities)
export * from "./tools";
export * from "./tools/agent/ask";
export * from "./tools/agent/irc";
export * from "./tools/agent/learn";
export * from "./tools/agent/manage-skill";
export * from "./tools/agent/memory-edit";
export * from "./tools/agent/memory-recall";
export * from "./tools/agent/memory-reflect";
export * from "./tools/agent/memory-retain";
export * from "./tools/agent/report-tool-issue";
export * from "./tools/agent/resolve";
export * from "./tools/agent/review";
export * from "./tools/agent/todo";
export * from "./tools/agent/vibe";
export * from "./tools/agent/yield";
export * from "./tools/fs/checkpoint";
export * from "./tools/fs/inspect-image";
export * from "./tools/fs/read";
export * from "./tools/fs/write";
export * from "./tools/search/ast-edit";
export * from "./tools/search/search";
export * from "./tools/search/search-tool-bm25";
export * from "./tools/shell/bash";
export * from "./tools/shell/debug";
export * from "./tools/shell/eval";
export * from "./tools/shell/eval-backends";
export * from "./tools/shell/job";
export * from "./tools/shell/launch";
export * from "./tools/shell/ssh";
export * from "./tools/web/browser";
export * from "./tools/web/gh";
export * from "./tools/web/image-gen";
export * from "./tools/web/tts";
export * from "./utils/git";
export * from "./web/search";
// UI components for extensions
export {
	HookEditorComponent as ExtensionEditorComponent,
	HookInputComponent as ExtensionInputComponent,
	HookSelectorComponent as ExtensionSelectorComponent,
};
