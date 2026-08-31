//! Pinned opt-outs for layout, selection, disclosure, and continuous adjustment
//! commands.

use super::OptOut;

pub fn navigation_opt_outs() -> &'static [OptOut] {
	&[
		OptOut {
			command_name: "StepSettingsPage",
			reason:       "relative page step bound to arrow keys in settings view",
		},
		OptOut {
			command_name: "ResizeSidebar",
			reason:       "continuous layout dimension set by pointer dragging",
		},
		OptOut {
			command_name: "ResizeInspector",
			reason:       "continuous layout dimension set by pointer dragging",
		},
		OptOut {
			command_name: "ResizeBottomDock",
			reason:       "continuous layout dimension set by pointer dragging",
		},
		OptOut {
			command_name: "ConstrainPanels",
			reason:       "window geometry constraint dispatched on window resize",
		},
		OptOut {
			command_name: "PinSession",
			reason:       "session pin toggle targeted to a specific session ID",
		},
		OptOut {
			command_name: "UnpinSession",
			reason:       "session unpin toggle targeted to a specific session ID",
		},
		OptOut {
			command_name: "OpenTab",
			reason:       "session tab open targeted to a specific session ID",
		},
		OptOut {
			command_name: "CloseTab",
			reason:       "tab closure targeted to a specific tab index",
		},
		OptOut {
			command_name: "MoveTab",
			reason:       "tab reordering index move dispatched by pointer dragging",
		},
		OptOut {
			command_name: "SelectTab",
			reason:       "tab selection targeted to a specific tab index",
		},
		OptOut {
			command_name: "CycleTabs",
			reason:       "tab cycling bound to keyboard shortcuts and tab strip gestures",
		},
		OptOut {
			command_name: "CreateSpace",
			reason:       "space creation prompted or dispatched from space switcher",
		},
		OptOut {
			command_name: "RenameSpace",
			reason:       "space renaming targeted to a specific space ID",
		},
		OptOut {
			command_name: "CloseSpace",
			reason:       "space closure targeted to a specific space ID",
		},
		OptOut {
			command_name: "SelectSpace",
			reason:       "space selection targeted to a specific space ID",
		},
		OptOut {
			command_name: "SelectSession",
			reason:       "session selection targeted to a specific session ID",
		},
		OptOut {
			command_name: "SelectEntry",
			reason:       "transcript entry selection targeted to a specific entry ID",
		},
		OptOut {
			command_name: "SelectFile",
			reason:       "file selection targeted to a specific file ID",
		},
		OptOut {
			command_name: "SelectAgent",
			reason:       "agent selection targeted to a specific agent ID",
		},
		OptOut {
			command_name: "SelectTerminal",
			reason:       "terminal tab selection targeted to a specific terminal ID",
		},
		OptOut {
			command_name: "SelectWorkspace",
			reason:       "workspace selection targeted to a specific workspace ID",
		},
		OptOut {
			command_name: "SelectDiagnostic",
			reason:       "diagnostic notice selection targeted to a specific notice ID",
		},
		OptOut {
			command_name: "SelectHunk",
			reason:       "diff hunk selection targeted to a specific file and hunk index",
		},
		OptOut {
			command_name: "SetChangesTreeMode",
			reason:       "tree display mode toggled by changes view header controls",
		},
		OptOut {
			command_name: "ToggleChangeFolder",
			reason:       "change folder expansion toggled by pointer click in tree",
		},
		OptOut {
			command_name: "ToggleChangeFile",
			reason:       "change file expansion toggled by pointer click in tree",
		},
		OptOut {
			command_name: "SetReviewRange",
			reason:       "diff review range set by drag selection in diff view",
		},
		OptOut {
			command_name: "AddReviewComment",
			reason:       "review comment submitted with specific session, path, range, and text",
		},
		OptOut {
			command_name: "StartReviewThread",
			reason:       "review thread created with specific path, line range, and initial comment",
		},
		OptOut {
			command_name: "ReplyReviewThread",
			reason:       "review reply submitted for specific thread",
		},
		OptOut {
			command_name: "EditReviewDraft",
			reason:       "review comment draft edited in contextual review composer",
		},
		OptOut {
			command_name: "ResolveReviewThread",
			reason:       "review thread resolved by card action in review surface",
		},
		OptOut {
			command_name: "UnresolveReviewThread",
			reason:       "review thread unresolved by card action in review surface",
		},
		OptOut {
			command_name: "ToggleReviewThreadResolved",
			reason:       "review thread resolved status toggled by card control",
		},
		OptOut {
			command_name: "DeleteReviewThread",
			reason:       "review thread deleted by card action",
		},
		OptOut {
			command_name: "DeleteReviewComment",
			reason:       "review comment deleted by comment card action",
		},
		OptOut {
			command_name: "SelectReviewThread",
			reason:       "review thread selected to focus anchor in changes route",
		},
		OptOut {
			command_name: "CreateChangeRequest",
			reason:       "change request created with title and thread associations",
		},
		OptOut {
			command_name: "SetChangeRequestState",
			reason:       "change request status set from change request card",
		},
		OptOut {
			command_name: "RemapReviewAnchors",
			reason:       "review anchors remapped on diff arrival",
		},
		OptOut {
			command_name: "SetChangeBase",
			reason:       "git diff base set by changes view branch selector",
		},
		OptOut {
			command_name: "RevealFile",
			reason:       "file reveal targeted to a specific file ID",
		},
		OptOut {
			command_name: "RevealSelectedFile",
			reason:       "file reveal in OS file manager bound to contextual shortcut",
		},
		OptOut {
			command_name: "ToggleProblemLevel",
			reason:       "diagnostic level filter toggled in problems view toolbar",
		},
		OptOut {
			command_name: "SetOutputPaused",
			reason:       "output streaming pause toggled in output panel toolbar",
		},
		OptOut {
			command_name: "SetOutputWrap",
			reason:       "output line wrapping toggled in output panel toolbar",
		},
		OptOut {
			command_name: "ToggleOutputLevel",
			reason:       "output log level filter toggled in output panel toolbar",
		},
		OptOut {
			command_name: "ToggleFileCursor",
			reason:       "file tree folder expansion toggled by keyboard navigation",
		},
		OptOut {
			command_name: "OpenFileCursor",
			reason:       "file tree entry opened by keyboard Enter in file tree",
		},
		OptOut {
			command_name: "SetHistoryFilter",
			reason:       "continuous text input from history search field",
		},
		OptOut {
			command_name: "SetHistoryGroupBy",
			reason:       "history grouping mode selected from in-surface controls",
		},
		OptOut {
			command_name: "ToggleHistoryGroup",
			reason:       "history section disclosure toggled by clicking group header",
		},
		OptOut {
			command_name: "CollapseAllHistoryGroups",
			reason:       "history section collapse all dispatched from in-surface controls",
		},
		OptOut {
			command_name: "ExpandAllHistoryGroups",
			reason:       "history section expand all dispatched from in-surface controls",
		},
		OptOut {
			command_name: "SetFileSearchMode",
			reason:       "file search mode toggled in file search header",
		},
		OptOut {
			command_name: "MoveFileCursor",
			reason:       "file tree cursor stepped by arrow key navigation",
		},
		OptOut {
			command_name: "SetFileRange",
			reason:       "file line range selection set by editor interaction",
		},
		OptOut {
			command_name: "SetTerminalPresentation",
			reason:       "terminal presentation mode toggled in terminal toolbar",
		},
		OptOut {
			command_name: "SetTerminalFollowTail",
			reason:       "terminal auto-scroll toggled in terminal toolbar",
		},
		OptOut {
			command_name: "SplitTerminal",
			reason:       "terminal split layout created with specific terminal IDs and axis",
		},
		OptOut {
			command_name: "SetTerminalSplitRatio",
			reason:       "terminal split ratio adjusted by drag split handle",
		},
		OptOut {
			command_name: "SetPlanReviewTab",
			reason:       "plan review tab selected in plan review overlay",
		},
		OptOut {
			command_name: "ToggleToolDisclosure",
			reason:       "tool call disclosure toggled by pointer click in message",
		},
		OptOut {
			command_name: "ToggleEntryDisclosure",
			reason:       "entry disclosure toggled by pointer click in transcript",
		},
		OptOut {
			command_name: "ToggleAgentExpanded",
			reason:       "agent item disclosure toggled by pointer click in agent list",
		},
		OptOut {
			command_name: "ToggleFileExpanded",
			reason:       "file folder disclosure toggled by pointer click in files view",
		},
		OptOut {
			command_name: "AddAttachment",
			reason:       "attachment added with specific attachment kind payload",
		},
		OptOut {
			command_name: "RemoveAttachment",
			reason:       "attachment removed by ID from draft composer",
		},
		OptOut {
			command_name: "ChooseFiles",
			reason:       "native file picker launched from composer attachment button",
		},
		OptOut {
			command_name: "ChooseImages",
			reason:       "native image picker launched from composer attachment button",
		},
		OptOut {
			command_name: "ReattachAttachment",
			reason:       "attachment reattached by ID after file movement",
		},
		OptOut {
			command_name: "RetryAttachment",
			reason:       "failed attachment upload retried by ID",
		},
		OptOut {
			command_name: "SetModelFavorite",
			reason:       "model favorite starred by ID in model picker",
		},
		OptOut {
			command_name: "PreviewTheme",
			reason:       "theme preview activated on hover in settings",
		},
		OptOut {
			command_name: "CancelThemePreview",
			reason:       "theme preview canceled on hover exit in settings",
		},
		OptOut {
			command_name: "SetFontSize",
			reason:       "font size adjusted by numeric stepper in appearance settings",
		},
		OptOut {
			command_name: "SetDiffLayout",
			reason:       "diff display layout toggled in changes view toolbar",
		},
		OptOut {
			command_name: "SetDiffWrap",
			reason:       "diff line wrapping toggled in changes view toolbar",
		},
		OptOut {
			command_name: "SetDiffWhitespace",
			reason:       "diff whitespace visibility toggled in changes view toolbar",
		},
		OptOut {
			command_name: "SetGroupSessionsByWorkspace",
			reason:       "session grouping toggled in session list header",
		},
		OptOut {
			command_name: "CopyText",
			reason:       "arbitrary text copied to system clipboard by button click",
		},
		OptOut {
			command_name: "FocusTerminal",
			reason:       "terminal focus directed to a specific terminal ID",
		},
		OptOut {
			command_name: "CopyEntry",
			reason:       "transcript entry content copied to clipboard by message action",
		},
		OptOut {
			command_name: "OpenImage",
			reason:       "image lightbox opened for a specific transcript entry and image index",
		},
		OptOut {
			command_name: "CopyTerminalSelection",
			reason:       "selected terminal text copied to clipboard from terminal view",
		},
		OptOut {
			command_name: "PasteTerminal",
			reason:       "clipboard text pasted into a specific terminal ID",
		},
		OptOut {
			command_name: "AddTerminalSelection",
			reason:       "terminal text appended to draft composer from terminal selection",
		},
		OptOut {
			command_name: "CopyDiagnostic",
			reason:       "diagnostic text copied to clipboard from notice row",
		},
		OptOut {
			command_name: "OpenDiagnostic",
			reason:       "diagnostic location opened in editor from problems row",
		},
	]
}
