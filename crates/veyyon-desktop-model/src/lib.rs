pub mod action;
pub mod action_kind;
pub mod badge;
pub mod base64_bytes;
pub mod capabilities;
pub mod coalescer;
pub mod composer;
pub mod connection;
pub mod damage;
pub mod domain;
pub mod error;
pub mod event;
pub mod gate;
pub mod interaction;
pub mod persistence;
pub mod reducer;
pub mod registry;
pub mod session;
pub mod store;
pub mod streaming;
pub mod surface;
pub mod tool_view;
pub mod transcript;

pub use action::{AttachmentSubmission, HostAction, HostRequest};
pub use action_kind::HostActionKind;
pub use badge::session_badge;
pub use capabilities::{Capability, CapabilityMap, CapabilityStatus};
pub use coalescer::{EventCoalescer, EventCoalescerError};
pub use composer::QueueMode;
pub use connection::{
	ConnectionState, ConnectionStateKind, EntryId, InteractionId, PROTOCOL_VERSION, RequestId,
	SessionId, Versioned,
};
pub use damage::{Damage, DamageSet};
pub use domain::{
	AgentView, AuthFlowState, AuthFlowView, ChangeScope, ChangeStatus, ChangedFile, ChangesView,
	ContextBreakdownView, ContextCategory, Domains, ExportView, FileContentView, FileKind, FileNode,
	FileTreeView, InputModality, KeybindingView, McpServerStatus, McpServerView, McpToolResultView,
	ModelRef, ModelView, ModelsView, PROCESS_LOG_CAPACITY_LINES, ProcessLogView, ProcessLogsChunk,
	ProcessView, ProviderView, QueuedPrompts, QueuedPromptsView, SearchResultsView, SeqGap,
	SettingEntry, SettingKind, SettingOption, SettingsView, TERMINAL_SCROLLBACK_CAPACITY_BYTES,
	TerminalOutputChunk, TerminalScrollback, TerminalStatus, TerminalView, ThemeView, ThemesView,
	UsageView,
};
pub use error::{BackendError, ErrorScope, fallback_surface, is_scope_retryable, route_error};
pub use event::{
	ALL_SECTION_NAMES, HostEvent, HostEventKind, SessionHeaderView, SessionLoadError, SessionStatus,
	SessionSummary, SnapshotSection, SnapshotSectionKind,
};
pub use gate::{Gate, action_to_capability, gate, gate_capability, gate_kind};
pub use interaction::{
	ApprovalInteraction, PendingDecisions, PlanInteraction, QuestionInteraction,
};
pub use persistence::{
	ComposerStore, DiffMode, PanelsStore, PersistedState, PersistenceError, QueueStore, Rejection,
	ShellStore, StoreKind, TranscriptAnchor, TranscriptStore, VersionedStore, WindowStore,
	load_or_default, validate_and_deserialize,
};
pub use reducer::reduce;
pub use registry::{InFlightRequest, RequestRegistry};
pub use session::{BadgeKind, QueuePartition, Session, SessionBadge, SessionCollection};
pub use store::Store;
pub use streaming::StreamingMessageState;
pub use surface::SurfaceId;
pub use tool_view::{
	FramedBlockView, HeadedBlockView, NoticeView, StatusRowBadge, StatusRowView, TextBlockView,
	ToolPresentation, ToolView, ToolViewContext, ViewCodeLines, ViewContentsKind, ViewDiffLines,
	ViewDiffSide, ViewHiddenCount, ViewLine, ViewNoun, ViewSection, ViewSpan, ViewStatus,
	ViewTailWindow, ViewTone, ViewTreeLines,
};
pub use transcript::{
	BlockKind, ContentBlock, EntryMeta, MessageRole, TranscriptEntry, TranscriptTree, UsageTotals,
};
