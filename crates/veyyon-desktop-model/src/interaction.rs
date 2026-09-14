use serde::{Deserialize, Serialize};

use crate::connection::InteractionId;

/// Single definition of operator decision requests awaiting input, approval, or
/// plan review.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingDecisions {
	pub approvals: Vec<ApprovalInteraction>,
	pub questions: Vec<QuestionInteraction>,
	pub plans:     Vec<PlanInteraction>,
}

impl PendingDecisions {
	/// Creates an empty pending decisions container.
	#[must_use]
	pub const fn new() -> Self {
		Self { approvals: Vec::new(), questions: Vec::new(), plans: Vec::new() }
	}

	/// Returns true if all decision queues are empty.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.approvals.is_empty() && self.questions.is_empty() && self.plans.is_empty()
	}
}

/// Pending tool execution approval request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalInteraction {
	pub id:              InteractionId,
	pub tool_name:       String,
	pub detail:          String,
	pub requested_at_ms: u64,
}

/// Pending user question requiring option selection or text entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionInteraction {
	pub id:              InteractionId,
	pub prompt:          String,
	pub options:         Vec<String>,
	pub requested_at_ms: u64,
}

/// Pending plan review requiring acceptance, refinement, or new session fork.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanInteraction {
	pub id:              InteractionId,
	pub markdown_plan:   String,
	pub requested_at_ms: u64,
}
