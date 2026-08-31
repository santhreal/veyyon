//! Classification of UI commands into frontend, host, and shell dispatch
//! domains.

use super::{CommandClass, UiCommand};

impl UiCommand {
	pub fn class(&self) -> CommandClass {
		match self {
			Self::Navigate(_)
			| Self::SetBottomTab(_)
			| Self::SetInspectorTab(_)
			| Self::ToggleSidebar
			| Self::ToggleInspector
			| Self::ToggleBottomDock
			| Self::ResizeSidebar { .. }
			| Self::ResizeInspector { .. }
			| Self::ResizeBottomDock { .. }
			| Self::ConstrainPanels { .. }
			| Self::OpenOverlay(_)
			| Self::CloseTopOverlay
			| Self::CloseAllOverlays
			| Self::SetPaletteQuery(_)
			| Self::MovePaletteCursor { .. }
			| Self::AcceptPalette
			| Self::StepSettingsPage { .. }
			| Self::SetSessionFilter(_)
			| Self::PinSession(_)
			| Self::UnpinSession(_)
			| Self::CycleSession { .. }
			| Self::OpenTab(_)
			| Self::CloseTab { .. }
			| Self::MoveTab { .. }
			| Self::SelectTab(_)
			| Self::CycleTabs { .. }
			| Self::CreateSpace { .. }
			| Self::RenameSpace { .. }
			| Self::CloseSpace(_)
			| Self::SelectSpace(_)
			| Self::SetFileFilter(_)
			| Self::SetAgentFilter(_)
			| Self::SetSettingsFilter(_)
			| Self::SetHistoryFilter(_)
			| Self::SetHistoryGroupBy(_)
			| Self::ToggleHistoryGroup(_)
			| Self::CollapseAllHistoryGroups
			| Self::ExpandAllHistoryGroups
			| Self::SetChangesFilter(_)
			| Self::SetChangesTreeMode(_)
			| Self::ToggleChangeFolder(_)
			| Self::ToggleChangeFile(_)
			| Self::SetReviewRange { .. }
			| Self::AddReviewComment { .. }
			| Self::StartReviewThread { .. }
			| Self::ReplyReviewThread { .. }
			| Self::EditReviewDraft { .. }
			| Self::ResolveReviewThread(_)
			| Self::UnresolveReviewThread(_)
			| Self::ToggleReviewThreadResolved(_)
			| Self::DeleteReviewThread(_)
			| Self::DeleteReviewComment { .. }
			| Self::SelectReviewThread(_)
			| Self::CreateChangeRequest { .. }
			| Self::SetChangeRequestState { .. }
			| Self::RemapReviewAnchors
			| Self::SetProblemFilter(_)
			| Self::ToggleProblemLevel(_)
			| Self::SetOutputPaused(_)
			| Self::SetOutputWrap(_)
			| Self::ToggleOutputLevel(_)
			| Self::SetModelQuery(_)
			| Self::SetProviderQuery(_)
			| Self::SetMcpQuery(_)
			| Self::SetExtensionQuery(_)
			| Self::SelectSession(_)
			| Self::SelectEntry(_)
			| Self::SelectFile(_)
			| Self::SelectAgent(_)
			| Self::SelectTerminal(_)
			| Self::SelectWorkspace(_)
			| Self::SetFileSearchMode(_)
			| Self::MoveFileCursor { .. }
			| Self::SetFileRange(_)
			| Self::ToggleFileCursor
			| Self::SelectDiagnostic(_)
			| Self::SelectHunk { .. }
			| Self::SetTerminalPresentation(_)
			| Self::SetTerminalSearch { .. }
			| Self::SetTerminalFollowTail { .. }
			| Self::SplitTerminal { .. }
			| Self::SetTerminalSplitRatio { .. }
			| Self::SetPlanReviewTab(_)
			| Self::ToggleToolDisclosure(_)
			| Self::ToggleEntryDisclosure(_)
			| Self::ToggleAgentExpanded(_)
			| Self::ToggleFileExpanded(_)
			| Self::EditDraft { .. }
			| Self::SetDraftCaret { .. }
			| Self::SetDraftSelection { .. }
			| Self::AddAttachment { .. }
			| Self::RemoveAttachment { .. }
			| Self::RetryAttachment { .. }
			| Self::EditAgentChatDraft { .. }
			| Self::SetModelFavorite { .. }
			| Self::EditSetting { .. }
			| Self::PreviewTheme(_)
			| Self::SetTheme(_)
			| Self::CancelThemePreview
			| Self::SetDarkAppearance(_)
			| Self::SetFontSize { .. }
			| Self::StepFontSize { .. }
			| Self::SetReducedMotion(_)
			| Self::SetDiffLayout(_)
			| Self::SetDiffWrap(_)
			| Self::SetDiffWhitespace(_)
			| Self::SetGroupSessionsByWorkspace(_)
			| Self::SelectInteractionOption { .. }
			| Self::ToggleInteractionOption { .. }
			| Self::EditInteractionText { .. }
			| Self::EditInteractionNote { .. }
			| Self::AddTerminalSelection { .. }
			| Self::NextDiagnostic { .. }
			| Self::DismissNotice(_) => CommandClass::Frontend,
			Self::QuitWindow
			| Self::ChooseFiles { .. }
			| Self::ChooseImages { .. }
			| Self::ReattachAttachment { .. }
			| Self::CopyText(_)
			| Self::FocusComposer
			| Self::FocusPalette
			| Self::FocusTerminal(_)
			| Self::CopyEntry(_)
			| Self::OpenImage { .. }
			| Self::JumpToLatest
			| Self::JumpToOldest
			| Self::RevealSelectedFile
			| Self::RevealFile(_)
			| Self::CopyTerminalSelection { .. }
			| Self::PasteTerminal(_)
			| Self::CopyDiagnostic(_)
			| Self::OpenDiagnostic(_)
			| Self::CopyOutput => CommandClass::Shell,
			Self::Attach { .. }
			| Self::Detach
			| Self::RetryConnection
			| Self::RequestShutdown
			| Self::LoadSessions
			| Self::LoadTranscript { .. }
			| Self::RetryTranscript { .. }
			| Self::CreateSession { .. }
			| Self::OpenSession(_)
			| Self::RenameSession { .. }
			| Self::DeleteSession(_)
			| Self::BranchSession { .. }
			| Self::ExportSession { .. }
			| Self::CompactSession { .. }
			| Self::HandoffSession { .. }
			| Self::SubmitPrompt { .. }
			| Self::Steer { .. }
			| Self::FollowUp { .. }
			| Self::AbortTurn { .. }
			| Self::SetQueueMode { .. }
			| Self::CancelTool(_)
			| Self::SubmitInteraction { .. }
			| Self::CancelInteraction { .. }
			| Self::LoadFileTree { .. }
			| Self::ReadFile { .. }
			| Self::SearchFiles { .. }
			| Self::OpenExternal(_)
			| Self::RefreshChanges(_)
			| Self::SetChangeBase(_)
			| Self::SelectChangeScope(_)
			| Self::CreateTerminal { .. }
			| Self::AttachTerminal(_)
			| Self::WriteTerminal { .. }
			| Self::ResizeTerminal { .. }
			| Self::RestartTerminal(_)
			| Self::ClearTerminal(_)
			| Self::CloseTerminal(_)
			| Self::RefreshProcesses
			| Self::FetchProcessLogs { .. }
			| Self::OpenFileCursor
			| Self::SendProcessInput { .. }
			| Self::SignalProcess { .. }
			| Self::StopProcess(_)
			| Self::RestartProcess(_)
			| Self::RefreshModels
			| Self::SelectModel { .. }
			| Self::StartProcess { .. }
			| Self::WaitProcess(_)
			| Self::DescribeProcess(_)
			| Self::SetThinkingLevel(_)
			| Self::RefreshProviders
			| Self::StartProviderAuth(_)
			| Self::RefreshAuth
			| Self::SubmitAuthSecret { .. }
			| Self::OpenAuthUrl { .. }
			| Self::CancelAuthFlow { .. }
			| Self::RetryAuthFlow { .. }
			| Self::RefreshMcp
			| Self::ConnectMcp(_)
			| Self::DisconnectMcp(_)
			| Self::SetMcpEnabled { .. }
			| Self::CallMcpTool { .. }
			| Self::ReadMcpResource { .. }
			| Self::GetMcpPrompt { .. }
			| Self::RefreshExtensions
			| Self::InvokeExtensionAction { .. }
			| Self::SetExtensionEnabled { .. }
			| Self::SetToolEnabled { .. }
			| Self::RefreshAgents
			| Self::FetchAgentTranscript { .. }
			| Self::ChatAgent { .. }
			| Self::KillAgent(_)
			| Self::ReviveAgent(_)
			| Self::SpawnTask { .. }
			| Self::CancelTask(_)
			| Self::LoadSettings
			| Self::SetSetting { .. }
			| Self::ResetSetting(_)
			| Self::LoadThemes
			| Self::LoadKeybindings
			| Self::SetKeybinding { .. }
			| Self::RefreshDiagnostics
			| Self::RetryDiagnosticSource(_)
			| Self::ClearOutput
			| Self::GetUsage
			| Self::GetContextBreakdown => CommandClass::Host,
		}
	}
}
