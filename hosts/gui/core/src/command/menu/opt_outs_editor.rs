//! Pinned opt-outs for editor, draft, and field query commands.

use super::OptOut;

pub fn editor_opt_outs() -> &'static [OptOut] {
	&[
		OptOut {
			command_name: "EditDraft",
			reason:       "text input driven directly by multiline editor typing",
		},
		OptOut {
			command_name: "SetDraftCaret",
			reason:       "caret navigation driven directly by editor interactions",
		},
		OptOut {
			command_name: "SetDraftSelection",
			reason:       "selection range driven directly by pointer or keyboard selection",
		},
		OptOut {
			command_name: "EditAgentChatDraft",
			reason:       "agent chat text input driven directly by agent editor",
		},
		OptOut {
			command_name: "SetPaletteQuery",
			reason:       "query string updated directly by palette search field",
		},
		OptOut {
			command_name: "MovePaletteCursor",
			reason:       "palette cursor stepped directly by arrow key navigation",
		},
		OptOut {
			command_name: "AcceptPalette",
			reason:       "palette entry accepted directly by Enter key",
		},
		OptOut {
			command_name: "SetSessionFilter",
			reason:       "filter string updated directly by session list filter field",
		},
		OptOut {
			command_name: "SetFileFilter",
			reason:       "filter string updated directly by file tree filter field",
		},
		OptOut {
			command_name: "SetAgentFilter",
			reason:       "filter string updated directly by agent list filter field",
		},
		OptOut {
			command_name: "SetSettingsFilter",
			reason:       "filter string updated directly by settings search field",
		},
		OptOut {
			command_name: "SetChangesFilter",
			reason:       "filter string updated directly by changes filter field",
		},
		OptOut {
			command_name: "SetProblemFilter",
			reason:       "filter string updated directly by problems filter field",
		},
		OptOut {
			command_name: "SetModelQuery",
			reason:       "query string updated directly by model picker search field",
		},
		OptOut {
			command_name: "SetProviderQuery",
			reason:       "query string updated directly by provider search field",
		},
		OptOut {
			command_name: "SetMcpQuery",
			reason:       "query string updated directly by MCP search field",
		},
		OptOut {
			command_name: "SetExtensionQuery",
			reason:       "query string updated directly by extension search field",
		},
		OptOut {
			command_name: "SetTerminalSearch",
			reason:       "terminal search query updated directly by terminal search bar",
		},
		OptOut {
			command_name: "EditInteractionText",
			reason:       "interaction text input driven directly by interaction form",
		},
		OptOut {
			command_name: "EditInteractionNote",
			reason:       "interaction note input driven directly by interaction form",
		},
	]
}
