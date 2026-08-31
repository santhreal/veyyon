//! Tool lifecycle, approvals, questions, and structured interaction replicas.

use super::{AgentId, InteractionId, RequestId, ToolId, Value};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ToolState {
	Pending,
	WaitingForApproval,
	Running,
	StreamingResult,
	Succeeded,
	Failed,
	Cancelled,
	Interrupted,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ToolCallView {
	pub id:            ToolId,
	pub name:          String,
	pub intent:        Option<String>,
	pub arguments:     Value,
	pub state:         ToolState,
	pub result:        Option<Value>,
	pub is_error:      bool,
	pub started_at_ms: Option<u64>,
	pub ended_at_ms:   Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct InteractionOption {
	pub label:       String,
	pub description: Option<String>,
	pub preview:     Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ApprovalTier {
	Read,
	Write,
	Execute,
	Network,
	Elevated,
	Unknown(String),
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ApprovalDecision {
	AllowOnce,
	AllowSession,
	AllowAlways,
	Deny { reason: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum InteractionKind {
	Approval {
		tool:      ToolId,
		tool_name: String,
		tier:      ApprovalTier,
		reason:    Option<String>,
		risk:      Option<String>,
		scope:     Option<String>,
		arguments: String,
	},
	Ask {
		question:    String,
		header:      Option<String>,
		options:     Vec<InteractionOption>,
		multiple:    bool,
		recommended: Option<usize>,
		preselected: Vec<usize>,
	},
	Select {
		title:    String,
		options:  Vec<InteractionOption>,
		multiple: bool,
	},
	Confirm {
		title:   String,
		message: String,
	},
	Input {
		title:       String,
		placeholder: Option<String>,
		secret:      bool,
	},
	Editor {
		title:    String,
		initial:  String,
		language: Option<String>,
	},
	OpenUrl {
		title: String,
		url:   String,
	},
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct InteractionRequest {
	pub id:          InteractionId,
	pub correlation: Option<RequestId>,
	pub agent:       Option<AgentId>,
	pub deadline_ms: Option<u64>,
	pub kind:        InteractionKind,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum InteractionResponse {
	Approval(ApprovalDecision),
	SubmitAsk { selected: Vec<usize>, custom: Option<String>, note: Option<String> },
	Select { selected: Vec<usize> },
	Confirm(bool),
	Text(String),
	OpenedUrl,
	Cancel { timed_out: bool },
}
