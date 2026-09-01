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
	McpConnectButton(String),
	McpDisconnectButton(String),
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
