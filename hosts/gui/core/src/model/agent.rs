//! Agent roster, progress, transcript paging, and task replicas.

use super::{AgentId, InteractionId, ModelId, RemoteData, TaskId, ToolId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum AgentKind {
	Main,
	Subagent,
	Remote,
	Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum AgentStatus {
	Starting,
	Running,
	Idle,
	Waiting,
	Parked,
	Aborting,
	Aborted,
	Completed,
	Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AgentProgressView {
	pub current_tool:           Option<ToolId>,
	pub recent_tools:           Vec<ToolId>,
	pub recent_output:          Vec<String>,
	pub requests:               Vec<InteractionId>,
	pub lifetime_tokens:        u64,
	pub cost_microusd:          Option<u64>,
	pub duration_ms:            u64,
	pub current_context_tokens: u64,
	pub context_window:         Option<u64>,
	pub resolved_model:         Option<ModelId>,
	pub fallback_model:         Option<ModelId>,
	pub retry:                  Option<String>,
	pub failure:                Option<String>,
	pub tasks:                  Vec<TaskId>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AgentView {
	pub id:                     AgentId,
	pub display_name:           String,
	pub kind:                   AgentKind,
	pub parent:                 Option<AgentId>,
	pub status:                 AgentStatus,
	pub scope:                  Option<String>,
	pub activity:               Option<String>,
	pub model:                  Option<ModelId>,
	pub started_at_ms:          Option<u64>,
	pub updated_at_ms:          Option<u64>,
	pub session_file_available: bool,
	pub pending_approval:       Option<InteractionId>,
	pub waiting_on_peer:        Option<AgentId>,
	pub progress:               Option<AgentProgressView>,
	pub participants:           Vec<AgentId>,
	pub transcript_read_only:   bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum TaskStatus {
	Pending,
	Running,
	Waiting,
	Completed,
	Cancelled,
	Failed,
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TaskItemView {
	pub id:     String,
	pub title:  String,
	pub status: TaskStatus,
	pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TaskPhaseView {
	pub id:     String,
	pub title:  String,
	pub status: TaskStatus,
	pub items:  Vec<TaskItemView>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TaskView {
	pub id:             TaskId,
	pub agent:          AgentId,
	pub title:          String,
	pub assignment:     String,
	pub description:    Option<String>,
	pub parent_tool:    Option<ToolId>,
	pub phases:         Vec<TaskPhaseView>,
	pub status:         TaskStatus,
	pub progress_milli: Option<u16>,
	pub message:        Option<String>,
	pub started_at_ms:  Option<u64>,
	pub ended_at_ms:    Option<u64>,
	pub duration_ms:    Option<u64>,
	pub cost_microusd:  Option<u64>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AgentTranscriptPage {
	pub agent:     AgentId,
	pub from_byte: u64,
	pub next_byte: Option<u64>,
	pub entries:   Vec<super::TranscriptEntry>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AgentRosterState {
	pub agents:       RemoteData<Vec<AgentView>>,
	pub subscription: Option<String>,
	pub transcripts:  Vec<(AgentId, RemoteData<AgentTranscriptPage>)>,
}
