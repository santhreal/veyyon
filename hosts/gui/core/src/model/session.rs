//! Workspace, session, runtime, plan, and lifecycle replicas.

use super::{
	EntryId, InteractionId, ModelId, ProviderId, RemoteData, RequestId, SessionId, TaskId,
	Versioned, WorkspaceId,
};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorkspaceView {
	pub id:     WorkspaceId,
	pub name:   String,
	pub root:   String,
	pub branch: Option<String>,
	pub dirty:  Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SessionStatus {
	Complete,
	Interrupted,
	Aborted,
	Error,
	Pending,
	Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SessionSummary {
	pub id:                  SessionId,
	pub workspace:           WorkspaceId,
	pub path:                String,
	pub cwd:                 String,
	pub title:               Option<String>,
	pub parent_path:         Option<String>,
	pub created_at_ms:       u64,
	pub modified_at_ms:      u64,
	pub message_count:       u64,
	pub size_bytes:          u64,
	pub first_message:       Option<String>,
	pub searchable_messages: Option<String>,
	pub status:              SessionStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SessionLoadError {
	pub path:   String,
	pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SessionHeaderView {
	pub id:             SessionId,
	pub schema_version: u32,
	pub title:          Option<String>,
	pub title_source:   Option<String>,
	pub parent:         Option<SessionId>,
	pub created_at_ms:  u64,
	pub cwd:            String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SessionIndexReplica {
	pub sessions:   RemoteData<Versioned<Vec<SessionSummary>>>,
	pub unreadable: Vec<SessionLoadError>,
}

impl Default for SessionIndexReplica {
	fn default() -> Self {
		Self { sessions: RemoteData::Unrequested, unreadable: Vec::new() }
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum TurnPhase {
	Preparing,
	Thinking,
	Responding,
	UsingTool,
	WaitingForInput,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum TurnState {
	Idle,
	Running { turn_id: Option<String>, started_at_ms: u64, phase: TurnPhase },
	Aborting,
	Retrying { attempt: u32, max: u32, delay_ms: u64, error: String, mode: String },
	Compacting { reason: String, action: String },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum QueueDelivery {
	Immediate,
	Queued,
	Disabled,
	Unknown(String),
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum InterruptMode {
	AbortThenSend,
	Queue,
	Disabled,
	Unknown(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SubmissionMode {
	Prompt,
	Steer,
	FollowUp,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct QueueState {
	pub count:             u32,
	pub steering:          QueueDelivery,
	pub follow_up:         QueueDelivery,
	pub interrupt:         InterruptMode,
	pub active_submission: SubmissionMode,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PromptConstraints {
	pub max_characters:     Option<usize>,
	pub max_attachments:    Option<usize>,
	pub allowed_modalities: Vec<String>,
	pub validation_error:   Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SessionRuntimeView {
	pub session:            SessionId,
	pub file:               Option<String>,
	pub name:               Option<String>,
	pub provider:           Option<ProviderId>,
	pub model:              Option<ModelId>,
	pub thinking_level:     Option<String>,
	pub streaming:          bool,
	pub compacting:         bool,
	pub auto_compaction:    bool,
	pub message_count:      u64,
	pub queue:              QueueState,
	pub todos:              Vec<TodoPhase>,
	pub context:            Option<super::ContextUsage>,
	pub turn:               TurnState,
	pub prompt_constraints: PromptConstraints,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TodoItem {
	pub id:     TaskId,
	pub title:  String,
	pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TodoPhase {
	pub title: String,
	pub items: Vec<TodoItem>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum PlanState {
	Disabled,
	Active {
		file_path: String,
		workflow:  Option<String>,
		reentry:   Option<String>,
		content:   RemoteData<String>,
		/// Boxed: a plan that is active without a pending approval is the common
		/// state, and the approval's own fields are most of this variant's size.
		approval:  Option<Box<PlanApproval>>,
	},
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PlanApproval {
	pub title:       Option<String>,
	pub summary:     Option<String>,
	pub request:     Option<RequestId>,
	pub interaction: Option<InteractionId>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum AppPhase {
	Detached,
	Starting,
	Ready,
	ShuttingDown,
	Stopped,
	Fatal(String),
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SessionTransition {
	None,
	Creating,
	Switching { session: SessionId },
	Branching { entry: EntryId },
	Compacting,
	Closing,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LifecycleState {
	pub app:                AppPhase,
	pub session_transition: SessionTransition,
}
