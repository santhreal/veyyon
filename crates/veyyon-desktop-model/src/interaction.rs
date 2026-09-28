use serde::{Deserialize, Serialize};

use crate::connection::InteractionId;

/// Single definition of operator decision requests awaiting input, approval,
/// plan review or a multi-question dialog.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct PendingDecisions {
	pub approvals: Vec<ApprovalInteraction>,
	pub questions: Vec<QuestionInteraction>,
	pub plans:     Vec<PlanInteraction>,
	/// Dialogs of one or more questions answered together, which is what the
	/// `ask` tool raises.
	pub dialogs:   Vec<DialogInteraction>,
}

impl PendingDecisions {
	/// Creates an empty pending decisions container.
	#[must_use]
	pub const fn new() -> Self {
		Self {
			approvals: Vec::new(),
			questions: Vec::new(),
			plans:     Vec::new(),
			dialogs:   Vec::new(),
		}
	}

	/// Returns true if all decision queues are empty.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.approvals.is_empty()
			&& self.questions.is_empty()
			&& self.plans.is_empty()
			&& self.dialogs.is_empty()
	}
}

/// Pending tool execution approval request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct ApprovalInteraction {
	pub id:              InteractionId,
	pub tool_name:       String,
	pub detail:          String,
	pub requested_at_ms: u64,
}

/// Pending user question requiring option selection or text entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct QuestionInteraction {
	pub id:              InteractionId,
	pub prompt:          String,
	pub options:         Vec<String>,
	pub requested_at_ms: u64,
}

/// Pending plan review requiring acceptance, refinement, or new session fork.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct PlanInteraction {
	pub id:              InteractionId,
	pub markdown_plan:   String,
	pub requested_at_ms: u64,
}

/// A dialog of questions answered in one submission.
///
/// The `response` that answers it is `{ "kind": "submit", "answers": [...] }`
/// with one answer per question, or `{ "kind": "chat" }` to discuss the
/// questions instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct DialogInteraction {
	pub id:              InteractionId,
	pub questions:       Vec<DialogQuestion>,
	pub requested_at_ms: u64,
	/// When the host settles the dialog itself, taking each unanswered
	/// question's recommended option. Absent while it waits indefinitely.
	#[ts(optional)]
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub expires_at_ms:   Option<u64>,
}

/// One question of a dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct DialogQuestion {
	pub id:          String,
	pub question:    String,
	/// Short tab label for the question.
	#[ts(optional)]
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub header:      Option<String>,
	pub options:     Vec<DialogOption>,
	/// Whether more than one option may be selected.
	pub multi:       bool,
	/// Index of the option the asker recommends.
	#[ts(optional)]
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub recommended: Option<u32>,
	/// Indices of the options selected when the dialog opens.
	pub preselected: Vec<u32>,
}

/// One option of a dialog question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct DialogOption {
	pub label:       String,
	#[ts(optional)]
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description: Option<String>,
	/// Text drawn beside the option while it has focus, such as a code sample.
	#[ts(optional)]
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub preview:     Option<String>,
}
