//! Representative variants generator for UI commands.

use crate::{
	UiCommand,
	model::*,
	navigation::{
		AttachmentKind, BottomTab, ChangesTreeMode, DiffLayout, HistoryGroupBy, InspectorTab,
		Overlay, PaletteMode, PlanReviewTab, Route, TerminalPresentation,
	},
};

macro_rules! def_id {
	($func:ident, $type:ident) => {
		fn $func() -> $type {
			match $type::new("dummy") {
				Ok(id) => id,
				Err(_) => match $type::new("1") {
					Ok(id) => id,
					Err(_) => loop {},
				},
			}
		}
	};
}

def_id!(dummy_session_id, SessionId);
def_id!(dummy_entry_id, EntryId);
def_id!(dummy_file_id, FileId);
def_id!(dummy_agent_id, AgentId);
def_id!(dummy_terminal_id, TerminalId);
def_id!(dummy_workspace_id, WorkspaceId);
def_id!(dummy_notice_id, NoticeId);
def_id!(dummy_provider_id, ProviderId);
def_id!(dummy_model_id, ModelId);
def_id!(dummy_interaction_id, InteractionId);
def_id!(dummy_mcp_id, McpServerId);
def_id!(dummy_extension_id, ExtensionId);
def_id!(dummy_task_id, TaskId);
def_id!(dummy_process_id, ProcessId);
def_id!(dummy_tool_id, ToolId);
def_id!(dummy_attachment_id, AttachmentId);
def_id!(dummy_space_id, SpaceId);

/// A representative instance of every `UiCommand` variant for exhaustiveness
/// testing.
pub fn all_command_variants() -> Vec<UiCommand> {
	let sid = dummy_session_id();
	let eid = dummy_entry_id();
	let fid = dummy_file_id();
	let aid = dummy_agent_id();
	let tid = dummy_terminal_id();
	let wid = dummy_workspace_id();
	let nid = dummy_notice_id();
	let pid = dummy_provider_id();
	let mid = dummy_model_id();
	let iid = dummy_interaction_id();
	let mcpid = dummy_mcp_id();
	let extid = dummy_extension_id();
	let taskid = dummy_task_id();
	let procid = dummy_process_id();
	let toolid = dummy_tool_id();
	let attid = dummy_attachment_id();
	let spcid = dummy_space_id();

	vec![
		UiCommand::Navigate(Route::Conversation),
		UiCommand::StepSettingsPage { down: true },
		UiCommand::SetBottomTab(BottomTab::Terminals),
		UiCommand::SetInspectorTab(InspectorTab::Context),
		UiCommand::ToggleSidebar,
		UiCommand::ToggleInspector,
		UiCommand::ToggleBottomDock,
		UiCommand::ResizeSidebar { width_milli_px: 200_000 },
		UiCommand::ResizeInspector { width_milli_px: 200_000 },
		UiCommand::ResizeBottomDock { height_milli_px: 200_000 },
		UiCommand::ConstrainPanels { width_milli_px: 1_000_000, height_milli_px: 800_000 },
		UiCommand::OpenOverlay(Overlay::CommandPalette { mode: PaletteMode::Commands }),
		UiCommand::CloseTopOverlay,
		UiCommand::CloseAllOverlays,
		UiCommand::SetPaletteQuery(String::new()),
		UiCommand::MovePaletteCursor { down: true },
		UiCommand::AcceptPalette,
		UiCommand::SetSessionFilter(String::new()),
		UiCommand::PinSession(sid.clone()),
		UiCommand::UnpinSession(sid.clone()),
		UiCommand::CycleSession { forward: true },
		UiCommand::OpenTab(sid.clone()),
		UiCommand::CloseTab { index: 0, force: false },
		UiCommand::MoveTab { from: 0, to: 0 },
		UiCommand::SelectTab(0),
		UiCommand::CycleTabs { forward: true },
		UiCommand::CreateSpace { name: String::new() },
		UiCommand::RenameSpace { id: spcid.clone(), name: String::new() },
		UiCommand::CloseSpace(spcid.clone()),
		UiCommand::SelectSpace(spcid.clone()),
		UiCommand::SetFileFilter(String::new()),
		UiCommand::SetAgentFilter(String::new()),
		UiCommand::SetSettingsFilter(String::new()),
		UiCommand::SetHistoryFilter(String::new()),
		UiCommand::SetHistoryGroupBy(HistoryGroupBy::Date),
		UiCommand::ToggleHistoryGroup(String::new()),
		UiCommand::CollapseAllHistoryGroups,
		UiCommand::ExpandAllHistoryGroups,
		UiCommand::SetChangesFilter(String::new()),
		UiCommand::SetChangesTreeMode(ChangesTreeMode::List),
		UiCommand::ToggleChangeFolder(String::new()),
		UiCommand::ToggleChangeFile(fid.clone()),
		UiCommand::SetReviewRange { path: String::new(), range: None },
		UiCommand::AddReviewComment {
			session: sid.clone(),
			path:    String::new(),
			range:   LineRange { start: 1, end: 2 },
			text:    String::new(),
		},
		UiCommand::StartReviewThread {
			path:  "src/lib.rs".to_string(),
			range: LineRange { start: 1, end: 5 },
			text:  "Review note".to_string(),
		},
		UiCommand::ReplyReviewThread {
			thread_id: ReviewThreadId::new("thread-1"),
			text:      "Reply text".to_string(),
		},
		UiCommand::EditReviewDraft {
			thread_id: Some(ReviewThreadId::new("thread-1")),
			text:      "Draft text".to_string(),
		},
		UiCommand::ResolveReviewThread(ReviewThreadId::new("thread-1")),
		UiCommand::UnresolveReviewThread(ReviewThreadId::new("thread-1")),
		UiCommand::ToggleReviewThreadResolved(ReviewThreadId::new("thread-1")),
		UiCommand::DeleteReviewThread(ReviewThreadId::new("thread-1")),
		UiCommand::DeleteReviewComment {
			thread_id:  ReviewThreadId::new("thread-1"),
			comment_id: ReviewCommentId::new("comment-1"),
		},
		UiCommand::SelectReviewThread(Some(ReviewThreadId::new("thread-1"))),
		UiCommand::CreateChangeRequest {
			title:       "PR Title".to_string(),
			description: Some("PR Description".to_string()),
		},
		UiCommand::SetChangeRequestState {
			id:    ChangeRequestId::new("cr-1"),
			state: ChangeRequestState::Open,
		},
		UiCommand::RemapReviewAnchors,
		UiCommand::SetChangeBase(None),
		UiCommand::RevealFile(fid.clone()),
		UiCommand::SetProblemFilter(String::new()),
		UiCommand::ToggleProblemLevel(DiagnosticLevel::Error),
		UiCommand::SetOutputPaused(false),
		UiCommand::SetOutputWrap(true),
		UiCommand::ToggleOutputLevel(OutputLevel::Info),
		UiCommand::SetModelQuery(String::new()),
		UiCommand::SetProviderQuery(String::new()),
		UiCommand::SetMcpQuery(String::new()),
		UiCommand::SetExtensionQuery(String::new()),
		UiCommand::SelectSession(sid.clone()),
		UiCommand::SelectEntry(eid.clone()),
		UiCommand::SelectFile(fid.clone()),
		UiCommand::SelectAgent(aid.clone()),
		UiCommand::ToggleFileCursor,
		UiCommand::OpenFileCursor,
		UiCommand::SelectTerminal(tid.clone()),
		UiCommand::SelectWorkspace(wid.clone()),
		UiCommand::SetFileSearchMode(FileSearchMode::Name),
		UiCommand::MoveFileCursor { forward: true },
		UiCommand::SetFileRange(None),
		UiCommand::SelectDiagnostic(nid.clone()),
		UiCommand::SelectHunk { file: fid.clone(), hunk: 0 },
		UiCommand::SetTerminalPresentation(TerminalPresentation::BottomDock),
		UiCommand::SetTerminalSearch { terminal: tid.clone(), query: String::new() },
		UiCommand::SetTerminalFollowTail { terminal: tid.clone(), follow: true },
		UiCommand::SplitTerminal {
			terminal: tid.clone(),
			with:     tid.clone(),
			axis:     SplitAxis::Horizontal,
		},
		UiCommand::SetTerminalSplitRatio { ratio_milli: 500 },
		UiCommand::SetPlanReviewTab(PlanReviewTab::Outline),
		UiCommand::ToggleToolDisclosure(toolid),
		UiCommand::ToggleEntryDisclosure(eid.clone()),
		UiCommand::ToggleAgentExpanded(aid.clone()),
		UiCommand::ToggleFileExpanded(fid.clone()),
		UiCommand::EditDraft { session: sid.clone(), text: String::new() },
		UiCommand::SetDraftCaret { session: sid.clone(), byte: 0 },
		UiCommand::SetDraftSelection { session: sid.clone(), anchor: 0, head: 0 },
		UiCommand::AddAttachment {
			session: sid.clone(),
			kind:    AttachmentKind::File { path: String::new() },
		},
		UiCommand::RemoveAttachment { session: sid.clone(), attachment: attid.clone() },
		UiCommand::ChooseFiles { session: sid.clone() },
		UiCommand::ChooseImages { session: sid.clone() },
		UiCommand::ReattachAttachment { session: sid.clone(), attachment: attid.clone() },
		UiCommand::RetryAttachment { session: sid.clone(), attachment: attid },
		UiCommand::EditAgentChatDraft { agent: aid.clone(), text: String::new() },
		UiCommand::SetModelFavorite { provider: pid.clone(), model: mid.clone(), favorite: true },
		UiCommand::PreviewTheme(String::new()),
		UiCommand::CancelThemePreview,
		UiCommand::SetDarkAppearance(true),
		UiCommand::SetFontSize { milli_px: 16_000 },
		UiCommand::SetReducedMotion(false),
		UiCommand::SetDiffLayout(DiffLayout::Unified),
		UiCommand::SetDiffWrap(true),
		UiCommand::SetDiffWhitespace(false),
		UiCommand::SetGroupSessionsByWorkspace(false),
		UiCommand::QuitWindow,
		UiCommand::CopyText(String::new()),
		UiCommand::FocusComposer,
		UiCommand::FocusPalette,
		UiCommand::FocusTerminal(tid.clone()),
		UiCommand::CopyEntry(eid.clone()),
		UiCommand::OpenImage { entry: eid.clone(), index: 0 },
		UiCommand::JumpToLatest,
		UiCommand::JumpToOldest,
		UiCommand::RevealSelectedFile,
		UiCommand::CopyTerminalSelection { terminal: tid.clone(), text: String::new() },
		UiCommand::PasteTerminal(tid.clone()),
		UiCommand::AddTerminalSelection {
			session:  sid.clone(),
			terminal: tid.clone(),
			text:     String::new(),
		},
		UiCommand::CopyDiagnostic(nid.clone()),
		UiCommand::OpenDiagnostic(nid.clone()),
		UiCommand::CopyOutput,
		UiCommand::Attach { endpoint: None },
		UiCommand::Detach,
		UiCommand::RetryConnection,
		UiCommand::RequestShutdown,
		UiCommand::LoadSessions,
		UiCommand::LoadTranscript { session: sid.clone(), before: None },
		UiCommand::RetryTranscript { session: sid.clone() },
		UiCommand::CreateSession { workspace: None, parent: None },
		UiCommand::OpenSession(sid.clone()),
		UiCommand::RenameSession { session: sid.clone(), name: String::new() },
		UiCommand::DeleteSession(sid.clone()),
		UiCommand::BranchSession { session: sid.clone(), entry: eid.clone() },
		UiCommand::ExportSession { session: sid.clone(), output_path: None },
		UiCommand::CompactSession { session: sid.clone(), instructions: None },
		UiCommand::HandoffSession { session: sid.clone(), instructions: None },
		UiCommand::SubmitPrompt { session: sid.clone() },
		UiCommand::Steer { session: sid.clone() },
		UiCommand::FollowUp { session: sid.clone() },
		UiCommand::AbortTurn { session: sid.clone() },
		UiCommand::SetQueueMode {
			session:   sid.clone(),
			steering:  QueueDelivery::Immediate,
			follow_up: QueueDelivery::Queued,
			interrupt: InterruptMode::AbortThenSend,
		},
		UiCommand::CancelTool(dummy_tool_id()),
		UiCommand::SelectInteractionOption { interaction: iid.clone(), index: 0 },
		UiCommand::ToggleInteractionOption { interaction: iid.clone(), index: 0 },
		UiCommand::EditInteractionText { interaction: iid.clone(), text: String::new() },
		UiCommand::EditInteractionNote { interaction: iid.clone(), note: String::new() },
		UiCommand::SubmitInteraction {
			interaction: iid.clone(),
			response:    InteractionResponse::Confirm(true),
		},
		UiCommand::CancelInteraction { interaction: iid.clone(), timed_out: false },
		UiCommand::LoadFileTree { workspace: wid.clone(), parent: None },
		UiCommand::ReadFile { file: fid.clone(), range: None },
		UiCommand::SearchFiles {
			workspace: wid.clone(),
			query:     String::new(),
			mode:      FileSearchMode::Name,
		},
		UiCommand::OpenExternal(String::new()),
		UiCommand::RefreshChanges(ChangeScope::WorkingTree),
		UiCommand::SelectChangeScope(ChangeScope::WorkingTree),
		UiCommand::CreateTerminal { cwd: None },
		UiCommand::AttachTerminal(tid.clone()),
		UiCommand::WriteTerminal { terminal: tid.clone(), bytes: Vec::new() },
		UiCommand::ResizeTerminal { terminal: tid.clone(), cols: 80, rows: 24 },
		UiCommand::RestartTerminal(tid.clone()),
		UiCommand::ClearTerminal(tid.clone()),
		UiCommand::CloseTerminal(tid.clone()),
		UiCommand::StartProcess { spec: Value::Null },
		UiCommand::WaitProcess(procid.clone()),
		UiCommand::DescribeProcess(procid.clone()),
		UiCommand::RefreshProcesses,
		UiCommand::FetchProcessLogs { process: procid.clone(), from_byte: None },
		UiCommand::SendProcessInput { process: procid.clone(), text: String::new() },
		UiCommand::SignalProcess { process: procid.clone(), signal: "SIGTERM".to_owned() },
		UiCommand::StopProcess(procid.clone()),
		UiCommand::RestartProcess(procid.clone()),
		UiCommand::RefreshModels,
		UiCommand::SelectModel { provider: pid.clone(), model: mid.clone() },
		UiCommand::SetThinkingLevel("off".to_owned()),
		UiCommand::RefreshProviders,
		UiCommand::StartProviderAuth(pid.clone()),
		UiCommand::RefreshAuth,
		UiCommand::SubmitAuthSecret { provider: pid.clone(), secret: String::new() },
		UiCommand::OpenAuthUrl { provider: pid.clone(), url: String::new() },
		UiCommand::CancelAuthFlow { provider: pid.clone() },
		UiCommand::RetryAuthFlow { provider: pid.clone() },
		UiCommand::RefreshMcp,
		UiCommand::ConnectMcp(mcpid.clone()),
		UiCommand::DisconnectMcp(mcpid.clone()),
		UiCommand::SetMcpEnabled { server: mcpid.clone(), enabled: true },
		UiCommand::CallMcpTool {
			server:    mcpid.clone(),
			tool:      String::new(),
			arguments: Value::Null,
		},
		UiCommand::ReadMcpResource { server: mcpid.clone(), uri: String::new() },
		UiCommand::GetMcpPrompt {
			server:    mcpid.clone(),
			name:      String::new(),
			arguments: Vec::new(),
		},
		UiCommand::RefreshExtensions,
		UiCommand::InvokeExtensionAction {
			extension: extid.clone(),
			action:    String::new(),
			input:     Value::Null,
		},
		UiCommand::SetExtensionEnabled { extension: extid.clone(), enabled: true },
		UiCommand::SetToolEnabled { tool: String::new(), enabled: true },
		UiCommand::RefreshAgents,
		UiCommand::FetchAgentTranscript { agent: aid.clone(), from_byte: 0 },
		UiCommand::ChatAgent { agent: aid.clone(), message: String::new() },
		UiCommand::KillAgent(aid.clone()),
		UiCommand::ReviveAgent(aid.clone()),
		UiCommand::SpawnTask { agent: aid.clone(), prompt: String::new() },
		UiCommand::CancelTask(taskid.clone()),
		UiCommand::LoadSettings,
		UiCommand::EditSetting { path: SettingPath("dummy".to_owned()), value: Value::Null },
		UiCommand::SetSetting { path: SettingPath("dummy".to_owned()), value: Value::Null },
		UiCommand::ResetSetting(SettingPath("dummy".to_owned())),
		UiCommand::LoadThemes,
		UiCommand::SetTheme("dark".to_owned()),
		UiCommand::LoadKeybindings,
		UiCommand::SetKeybinding { command: String::new(), chord: None },
		UiCommand::RefreshDiagnostics,
		UiCommand::RetryDiagnosticSource(String::new()),
		UiCommand::NextDiagnostic { forward: true },
		UiCommand::DismissNotice(nid.clone()),
		UiCommand::ClearOutput,
		UiCommand::GetUsage,
		UiCommand::GetContextBreakdown,
	]
}
