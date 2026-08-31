//! Terminal, supervised-process, problems, and typed output replicas.

use super::{
	AgentId, EntryId, ExtensionId, FileId, NoticeId, ProcessId, RemoteData, TerminalId, ToolId,
	Versioned,
};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum TerminalPhase {
	Starting,
	Running,
	Reconnecting { attempt: u32, message: String },
	Exited,
	Error { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TerminalRunView {
	pub id:          TerminalId,
	pub command:     String,
	pub cwd:         String,
	pub phase:       TerminalPhase,
	pub output:      Vec<u8>,
	pub exit_code:   Option<i32>,
	pub signal:      Option<String>,
	pub cancelled:   bool,
	pub truncated:   bool,
	pub total_lines: u64,
	pub total_bytes: u64,
	pub error:       Option<String>,
	pub artifact_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SplitAxis {
	Horizontal,
	Vertical,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum TerminalLayout {
	Leaf(TerminalId),
	Split {
		axis:        SplitAxis,
		ratio_milli: u16,
		first:       Box<TerminalLayout>,
		second:      Box<TerminalLayout>,
	},
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ProcessPhase {
	Starting,
	Running,
	Ready,
	Restarting,
	Stopping,
	Exited,
	Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProcessView {
	pub id:            ProcessId,
	pub name:          String,
	pub phase:         ProcessPhase,
	pub pid:           Option<u32>,
	pub started_at_ms: Option<u64>,
	pub error:         Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProcessCompletion {
	pub process:     ProcessId,
	pub exit_code:   Option<i32>,
	pub signal:      Option<String>,
	pub ended_at_ms: u64,
	pub output_tail: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ProcessSupervisorState {
	pub processes:   RemoteData<Versioned<Vec<ProcessView>>>,
	pub completions: Vec<ProcessCompletion>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum OutputSource {
	Notice(NoticeId),
	Process(ProcessId),
	Tool(ToolId),
	Extension(ExtensionId),
	Agent(AgentId),
	Transcript(EntryId),
}

#[derive(
	Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
pub enum OutputLevel {
	Trace,
	Info,
	Warning,
	Error,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct OutputRecord {
	pub source:         OutputSource,
	pub level:          OutputLevel,
	pub message:        String,
	pub occurred_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProblemLocation {
	pub file:   FileId,
	pub path:   String,
	pub line:   u32,
	pub column: Option<u32>,
}
