use serde::{Deserialize, Serialize};

use crate::connection::{InteractionId, SessionId};

/// Identifiers for every interactive control across all visual surfaces capable
/// of initiating requests.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum SurfaceId {
	// Shell & Connection (§1.1, §4.1)
	ConnectionAttachButton,
	ConnectionDetachButton,
	ConnectionRetryButton,
	ShutdownButton,
	GlobalTitlebarLine,

	// Queue Controls (§5.2)
	QueueSessionRow(SessionId),
	QueueParkButton(SessionId),
	QueueUnparkButton(SessionId),
	QueueDeferButton(SessionId),
	QueueRecallButton(SessionId),
	QueuePinButton(SessionId),
	QueueUnpinButton(SessionId),
	QueueDeleteButton(SessionId),
	QueueFilterInput,

	// Session Header & Actions (§5.3)
	NewSessionButton,
	SessionBranchButton(SessionId),
	SessionRenameField(SessionId),
	SessionExportButton(SessionId),
	SessionCompactButton(SessionId),
	SessionHandoffButton(SessionId),

	// Composer & Turn Controls (§5.4)
	ComposerSendButton(SessionId),
	ComposerSteerButton(SessionId),
	ComposerQueueButton(SessionId),
	ComposerAbortButton(SessionId),
	ComposerModelSelector(SessionId),
	ComposerThinkingSelector(SessionId),
	ComposerQueueModeToggle(SessionId),
	ComposerQueuedTakeBack(SessionId),
	ComposerCancelToolButton(SessionId, String),

	// Decision Cards (§5.5)
	ApprovalApproveButton(SessionId, InteractionId),
	ApprovalDeclineButton(SessionId, InteractionId),
	ApprovalAlwaysAllowButton(SessionId, InteractionId),
	ApprovalCancelButton(SessionId, InteractionId),
	QuestionOptionButton(SessionId, InteractionId, usize),
	QuestionSubmitButton(SessionId, InteractionId),
	PlanAcceptButton(SessionId, InteractionId),
	PlanRefineButton(SessionId, InteractionId),
	PlanAcceptNewSessionButton(SessionId, InteractionId),

	// Right Panel (§5.6, §5.11)
	RightPanelDiffTab(SessionId),
	RightPanelFileTab(SessionId),
	RightPanelPreviewTab(SessionId),
	RightPanelSessionDetailTab(SessionId),
	RightPanelUsageTab(SessionId),
	RightPanelCloseTabButton(SessionId, String),
	RightPanelChangeScopeSelector(SessionId),

	// Terminal Drawer & Process Supervisor (§5.6, §5.12)
	TerminalCreateButton(SessionId),
	TerminalCloseButton(SessionId, String),
	TerminalRestartButton(SessionId, String),
	TerminalClearButton(SessionId, String),
	ProcessStartButton(SessionId),
	ProcessStopButton(SessionId, String),
	ProcessRestartButton(SessionId, String),
	ProcessSignalButton(SessionId, String),
	ProcessSendButton(SessionId, String),
	ProcessLogsTab(SessionId, String),

	// Palette (§5.8)
	PaletteInput,
	PaletteItem(usize),

	// Settings, Auth, MCP, Extensions, Diagnostics (§5.9)
	SettingsField(String),
	ThemeSelector,
	KeybindingField(String),
	ProviderAuthStartButton(String),
	ProviderAuthSecretSubmit(String),
	ProviderAuthUrlOpen(String),
	ProviderAuthCancelButton(String),
	ProviderAuthRetryButton(String),
	AuthRefreshButton,
	McpRetryButton(String),
	McpEnableToggle(String),
	TaskSpawnButton,
	TaskCancelButton(String),
	AgentReviveButton(String),
	DiagnosticRefreshButton,
	DiagnosticRetrySourceButton(String),
	OutputClearButton,
	UsageRefreshButton,
	ContextBreakdownRefreshButton,
}

impl SurfaceId {
	/// Whether this control is one the terminal drawer draws (§5.6, §5.12).
	///
	/// The drawer states the refusal any of its own controls landed on, so it
	/// asks here rather than naming a control: a request refused on a process
	/// row, on the strip's `New` or on the supervisor's `Start` is one press
	/// the operator made in one surface, and one place is where the host's
	/// sentence belongs. The match is exhaustive, so a control added to the
	/// vocabulary states which surface owns it before it compiles.
	#[must_use]
	pub const fn in_terminal_drawer(&self) -> bool {
		match self {
			Self::TerminalCreateButton(_)
			| Self::TerminalCloseButton(..)
			| Self::TerminalRestartButton(..)
			| Self::TerminalClearButton(..)
			| Self::ProcessStartButton(_)
			| Self::ProcessStopButton(..)
			| Self::ProcessRestartButton(..)
			| Self::ProcessSignalButton(..)
			| Self::ProcessSendButton(..)
			| Self::ProcessLogsTab(..) => true,
			Self::ConnectionAttachButton
			| Self::ConnectionDetachButton
			| Self::ConnectionRetryButton
			| Self::ShutdownButton
			| Self::GlobalTitlebarLine
			| Self::QueueSessionRow(_)
			| Self::QueueParkButton(_)
			| Self::QueueUnparkButton(_)
			| Self::QueueDeferButton(_)
			| Self::QueueRecallButton(_)
			| Self::QueuePinButton(_)
			| Self::QueueUnpinButton(_)
			| Self::QueueDeleteButton(_)
			| Self::QueueFilterInput
			| Self::NewSessionButton
			| Self::SessionBranchButton(_)
			| Self::SessionRenameField(_)
			| Self::SessionExportButton(_)
			| Self::SessionCompactButton(_)
			| Self::SessionHandoffButton(_)
			| Self::ComposerSendButton(_)
			| Self::ComposerSteerButton(_)
			| Self::ComposerQueueButton(_)
			| Self::ComposerAbortButton(_)
			| Self::ComposerModelSelector(_)
			| Self::ComposerThinkingSelector(_)
			| Self::ComposerQueueModeToggle(_)
			| Self::ComposerQueuedTakeBack(_)
			| Self::ComposerCancelToolButton(..)
			| Self::ApprovalApproveButton(..)
			| Self::ApprovalDeclineButton(..)
			| Self::ApprovalAlwaysAllowButton(..)
			| Self::ApprovalCancelButton(..)
			| Self::QuestionOptionButton(..)
			| Self::QuestionSubmitButton(..)
			| Self::PlanAcceptButton(..)
			| Self::PlanRefineButton(..)
			| Self::PlanAcceptNewSessionButton(..)
			| Self::RightPanelDiffTab(_)
			| Self::RightPanelFileTab(_)
			| Self::RightPanelPreviewTab(_)
			| Self::RightPanelSessionDetailTab(_)
			| Self::RightPanelUsageTab(_)
			| Self::RightPanelCloseTabButton(..)
			| Self::RightPanelChangeScopeSelector(_)
			| Self::PaletteInput
			| Self::PaletteItem(_)
			| Self::SettingsField(_)
			| Self::ThemeSelector
			| Self::KeybindingField(_)
			| Self::ProviderAuthStartButton(_)
			| Self::ProviderAuthSecretSubmit(_)
			| Self::ProviderAuthUrlOpen(_)
			| Self::ProviderAuthCancelButton(_)
			| Self::ProviderAuthRetryButton(_)
			| Self::AuthRefreshButton
			| Self::McpRetryButton(_)
			| Self::McpEnableToggle(_)
			| Self::TaskSpawnButton
			| Self::TaskCancelButton(_)
			| Self::AgentReviveButton(_)
			| Self::DiagnosticRefreshButton
			| Self::DiagnosticRetrySourceButton(_)
			| Self::OutputClearButton
			| Self::UsageRefreshButton
			| Self::ContextBreakdownRefreshButton => false,
		}
	}

	/// Whether this control is one the settings sheet draws (§5.9, §4.4).
	///
	/// The sheet states the refusal any of its own controls landed on, so it
	/// asks here rather than naming a control: a setting the host would not
	/// write, a server it would not enable, a theme it would not select and
	/// a source it would not re-run are presses the operator made in one
	/// surface, and one place is where the host's sentence belongs. The
	/// match is exhaustive, so a control added to the vocabulary states
	/// which surface owns it before it compiles.
	#[must_use]
	pub const fn in_settings_sheet(&self) -> bool {
		match self {
			Self::SettingsField(_)
			| Self::ThemeSelector
			| Self::KeybindingField(_)
			| Self::ProviderAuthStartButton(_)
			| Self::ProviderAuthSecretSubmit(_)
			| Self::ProviderAuthUrlOpen(_)
			| Self::ProviderAuthCancelButton(_)
			| Self::ProviderAuthRetryButton(_)
			| Self::AuthRefreshButton
			| Self::McpRetryButton(_)
			| Self::McpEnableToggle(_)
			| Self::TaskSpawnButton
			| Self::TaskCancelButton(_)
			| Self::AgentReviveButton(_)
			| Self::DiagnosticRefreshButton
			| Self::DiagnosticRetrySourceButton(_)
			| Self::UsageRefreshButton
			| Self::ContextBreakdownRefreshButton => true,
			Self::TerminalCreateButton(_)
			| Self::TerminalCloseButton(..)
			| Self::TerminalRestartButton(..)
			| Self::TerminalClearButton(..)
			| Self::ProcessStartButton(_)
			| Self::ProcessStopButton(..)
			| Self::ProcessRestartButton(..)
			| Self::ProcessSignalButton(..)
			| Self::ProcessSendButton(..)
			| Self::ProcessLogsTab(..)
			| Self::ConnectionAttachButton
			| Self::ConnectionDetachButton
			| Self::ConnectionRetryButton
			| Self::ShutdownButton
			| Self::GlobalTitlebarLine
			| Self::QueueSessionRow(_)
			| Self::QueueParkButton(_)
			| Self::QueueUnparkButton(_)
			| Self::QueueDeferButton(_)
			| Self::QueueRecallButton(_)
			| Self::QueuePinButton(_)
			| Self::QueueUnpinButton(_)
			| Self::QueueDeleteButton(_)
			| Self::QueueFilterInput
			| Self::NewSessionButton
			| Self::SessionBranchButton(_)
			| Self::SessionRenameField(_)
			| Self::SessionExportButton(_)
			| Self::SessionCompactButton(_)
			| Self::SessionHandoffButton(_)
			| Self::ComposerSendButton(_)
			| Self::ComposerSteerButton(_)
			| Self::ComposerQueueButton(_)
			| Self::ComposerAbortButton(_)
			| Self::ComposerModelSelector(_)
			| Self::ComposerThinkingSelector(_)
			| Self::ComposerQueueModeToggle(_)
			| Self::ComposerQueuedTakeBack(_)
			| Self::ComposerCancelToolButton(..)
			| Self::ApprovalApproveButton(..)
			| Self::ApprovalDeclineButton(..)
			| Self::ApprovalAlwaysAllowButton(..)
			| Self::ApprovalCancelButton(..)
			| Self::QuestionOptionButton(..)
			| Self::QuestionSubmitButton(..)
			| Self::PlanAcceptButton(..)
			| Self::PlanRefineButton(..)
			| Self::PlanAcceptNewSessionButton(..)
			| Self::RightPanelDiffTab(_)
			| Self::RightPanelFileTab(_)
			| Self::RightPanelPreviewTab(_)
			| Self::RightPanelSessionDetailTab(_)
			| Self::RightPanelUsageTab(_)
			| Self::RightPanelCloseTabButton(..)
			| Self::RightPanelChangeScopeSelector(_)
			| Self::PaletteInput
			| Self::PaletteItem(_)
			| Self::OutputClearButton => false,
		}
	}
}
