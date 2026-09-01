pub mod action;
pub mod action_kind;
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
pub mod transcript;

pub use action::{AttachmentSubmission, HostAction, HostRequest};
pub use action_kind::HostActionKind;
pub use capabilities::{Capability, CapabilityMap, CapabilityStatus};
pub use coalescer::{EventCoalescer, EventCoalescerError};
pub use composer::{ComposerDraft, QueueMode};
pub use connection::{
	ConnectionState, ConnectionStateKind, EntryId, InteractionId, PROTOCOL_VERSION, RequestId,
	SessionId, Versioned,
};
pub use damage::{Damage, DamageSet};
pub use domain::{
	AgentView, AuthFlowState, AuthFlowView, ChangeScope, ChangeStatus, ChangedFile, ChangesView,
	ContextBreakdownView, ContextCategory, Domains, ExportView, FileContentView, FileKind, FileNode,
	FileTreeView, KeybindingView, McpServerStatus, McpServerView, McpToolResultView, ModelRef,
	ModelView, ModelsView, PROCESS_LOG_CAPACITY_LINES, ProcessLogView, ProcessLogsChunk,
	ProcessView, ProviderView, SearchResultsView, SeqGap, TERMINAL_SCROLLBACK_CAPACITY_BYTES,
	TerminalOutputChunk, TerminalScrollback, TerminalStatus, TerminalView, ThemeView, ThemesView,
	UsageView,
};
pub use error::{BackendError, ErrorScope, fallback_surface, is_scope_retryable, route_error};
pub use event::{
	ALL_SECTION_NAMES, HostEvent, SessionHeaderView, SessionLoadError, SessionStatus,
	SessionSummary, SnapshotSection, SnapshotSectionKind,
};
pub use gate::{Gate, action_to_capability, gate, gate_kind};
pub use interaction::{
	ApprovalInteraction, PendingDecisions, PlanInteraction, QuestionInteraction,
};
pub use persistence::{
	ComposerStore, PanelsStore, PersistedState, PersistenceError, QueueStore, ShellStore,
	TokensStore, TranscriptStore, VersionedStore, WindowStore, load_or_default,
	validate_and_deserialize,
};
pub use reducer::reduce;
pub use registry::{InFlightRequest, RequestRegistry};
pub use session::{BadgeKind, QueuePartition, Session, SessionBadge, SessionCollection};
pub use store::Store;
pub use streaming::StreamingMessageState;
pub use surface::SurfaceId;
pub use transcript::{
	BlockKind, ContentBlock, EntryMeta, MessageRole, TranscriptEntry, TranscriptTree, UsageTotals,
};
