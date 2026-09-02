//! Turn phase and primary action resolution (§5.4).
//!
//! The turn phase represents the active conversational lifecycle of a session.
//! It dictates which primary and secondary actions are presented on the
//! composer, resolving the seven fundamental turn actions: Send, Steer, Queue,
//! Answer, Approve, Accept, and Refine.

use serde::{Deserialize, Serialize};
pub use veyyon_desktop_model::QueueMode;

/// Active conversational lifecycle phase for the open session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub enum TurnPhase {
	/// No turn is currently executing or awaiting operator decision.
	#[default]
	Idle,
	/// Assistant generation or tool execution is actively running.
	Running {
		/// Whether prompt submission steers the active turn or queues behind it.
		queue_mode: QueueMode,
	},
	/// The assistant is awaiting an answer to a question.
	QuestionPending {
		/// Number of discrete options offered.
		options: usize,
	},
	/// A tool execution approval is pending operator decision.
	ApprovalPending,
	/// A plan proposal is awaiting acceptance or refinement.
	PlanPending,
}

impl TurnPhase {
	/// Whether this phase represents an active generation or tool execution run.
	#[must_use]
	pub const fn is_running(&self) -> bool {
		matches!(self, Self::Running { .. })
	}

	/// Whether this phase is blocked waiting for an operator decision.
	#[must_use]
	pub const fn is_decision_pending(&self) -> bool {
		matches!(self, Self::QuestionPending { .. } | Self::ApprovalPending | Self::PlanPending)
	}
}

/// The seven primary actions available from the composer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PrimaryAction {
	/// Submit a new prompt when idle.
	Send,
	/// Steer in-flight assistant execution.
	Steer,
	/// Queue prompt behind active execution.
	Queue,
	/// Submit answer or option selection to a pending question.
	Answer,
	/// Grant approval for pending tool execution.
	Approve,
	/// Accept the proposed plan as written.
	Accept,
	/// Refine the proposed plan with composer text.
	Refine,
}

impl PrimaryAction {
	/// All seven primary turn actions.
	pub const ALL: [Self; 7] = [
		Self::Send,
		Self::Steer,
		Self::Queue,
		Self::Answer,
		Self::Approve,
		Self::Accept,
		Self::Refine,
	];

	/// The display label for the primary action button.
	#[must_use]
	pub const fn label(self) -> &'static str {
		match self {
			Self::Send => "Send",
			Self::Steer => "Steer",
			Self::Queue => "Queue",
			Self::Answer => "Answer",
			Self::Approve => "Approve",
			Self::Accept => "Accept",
			Self::Refine => "Refine",
		}
	}
}

/// Secondary actions paired with the primary action or accessible on split
/// buttons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SecondaryAction {
	/// Steer action offered on the secondary split button when in queue mode.
	Steer,
	/// Queue action offered on the secondary split button when in steer mode.
	Queue,
	/// Option selection shortcut triggers for questions.
	OptionKeys {
		/// Number of discrete options.
		count: usize,
	},
	/// Decline and Always Allow choices for approvals.
	ApprovalChoices,
	/// Fork and accept the proposed plan in a new session.
	AcceptInNewSession,
}

/// Resolves the primary action and optional secondary action from turn phase
/// and text state.
#[must_use]
pub const fn primary_action(
	turn: &TurnPhase,
	has_text: bool,
) -> (PrimaryAction, Option<SecondaryAction>) {
	match turn {
		TurnPhase::Idle => (PrimaryAction::Send, None),
		TurnPhase::Running { queue_mode: QueueMode::Steer } => {
			(PrimaryAction::Steer, Some(SecondaryAction::Queue))
		},
		TurnPhase::Running { queue_mode: QueueMode::Queue } => {
			(PrimaryAction::Queue, Some(SecondaryAction::Steer))
		},
		TurnPhase::QuestionPending { options } => {
			(PrimaryAction::Answer, Some(SecondaryAction::OptionKeys { count: *options }))
		},
		TurnPhase::ApprovalPending => {
			(PrimaryAction::Approve, Some(SecondaryAction::ApprovalChoices))
		},
		TurnPhase::PlanPending => {
			if has_text {
				(PrimaryAction::Refine, None)
			} else {
				(PrimaryAction::Accept, Some(SecondaryAction::AcceptInNewSession))
			}
		},
	}
}

/// Selected model identifier and provider descriptor.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub struct ModelChoice {
	/// Provider identifier.
	pub provider: String,
	/// Model identifier.
	pub model:    String,
}

impl ModelChoice {
	/// Creates a new model choice.
	#[must_use]
	pub fn new(provider: impl Into<String>, model: impl Into<String>) -> Self {
		Self { provider: provider.into(), model: model.into() }
	}
}

/// Thinking budget and reasoning level selection.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub struct ThinkingLevel {
	/// Thinking level identifier.
	pub level: String,
}

impl ThinkingLevel {
	/// Creates a new thinking level selection.
	#[must_use]
	pub fn new(level: impl Into<String>) -> Self {
		Self { level: level.into() }
	}
}
