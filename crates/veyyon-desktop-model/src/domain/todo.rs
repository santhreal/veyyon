//! The plan a session is working, as the window receives it.
//!
//! Every count in a board is the host's. The window states what it is given
//! and derives no tally of its own, so a plan the terminal reports as `4/9`
//! cannot be drawn here as anything else. What the window does decide is how a
//! board reads when it does not fit: which phase survives a narrow card and
//! what a status is marked with.

use serde::{Deserialize, Serialize};

/// What a task's state says about whether work is expected on it.
///
/// The vocabulary is the wire's `TODO_STATUS_IS_TERMINAL`, and
/// [`TodoStatus::closed`] answers the one question every surface asks, so a
/// status added upstream arrives with its terminality rather than borrowing
/// the pending reading and drawing open work as finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
	/// Waiting: no work has started on it.
	Pending,
	/// The task the agent is on.
	InProgress,
	/// Finished.
	Completed,
	/// Given up rather than finished, which is not the same outcome and is
	/// never drawn as one.
	Abandoned,
}

impl TodoStatus {
	/// The stable identifier matching the wire protocol.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Pending => "pending",
			Self::InProgress => "in_progress",
			Self::Completed => "completed",
			Self::Abandoned => "abandoned",
		}
	}

	/// Whether no further work is expected on a task in this state.
	#[must_use]
	pub const fn closed(self) -> bool {
		matches!(self, Self::Completed | Self::Abandoned)
	}

	/// The mark a task in this state is drawn with.
	///
	/// A `match` rather than a table so a status added to the enum stops the
	/// build here instead of borrowing the pending mark.
	#[must_use]
	pub const fn mark(self) -> &'static str {
		match self {
			Self::Pending => "○",
			Self::InProgress => "◐",
			Self::Completed => "●",
			Self::Abandoned => "⊘",
		}
	}
}

/// One task of the plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoTaskView {
	/// The task in the words the board records.
	pub content: String,
	/// Where the task stands.
	pub status:  TodoStatus,
}

/// One phase of the plan, with the tally the host computed for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoPhaseView {
	/// The phase as the board states it, numbered: `II. Shared`.
	pub name:   String,
	/// The phase's tasks, open work first.
	pub tasks:  Vec<TodoTaskView>,
	/// Tasks of this phase that are finished with: done or abandoned.
	pub closed: usize,
	/// The next actionable task belongs to this phase.
	pub active: bool,
}

impl TodoPhaseView {
	/// The phase's own tally, as `3/7`.
	#[must_use]
	pub fn tally(&self) -> String {
		format!("{}/{}", self.closed, self.tasks.len())
	}
}

/// The plan a session is working.
///
/// A session whose board holds no task publishes no view at all, so the
/// presence of one is what the card is drawn from and there is no empty board
/// to distinguish from an absent one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoBoardView {
	/// The phases in the order the board records them.
	pub phases:  Vec<TodoPhaseView>,
	/// Tasks closed across every phase.
	pub closed:  usize,
	/// Tasks recorded across every phase.
	pub total:   usize,
	/// The task in flight, or the first one waiting, or `None` once none is.
	pub current: Option<TodoTaskView>,
}

impl TodoBoardView {
	/// The board's tally, as `4/9`.
	#[must_use]
	pub fn tally(&self) -> String {
		format!("{}/{}", self.closed, self.total)
	}

	/// Whether every recorded task has closed.
	#[must_use]
	pub const fn finished(&self) -> bool {
		self.total > 0 && self.closed == self.total
	}

	/// The phase the next actionable task belongs to.
	#[must_use]
	pub fn active_phase(&self) -> Option<&TodoPhaseView> {
		self.phases.iter().find(|phase| phase.active)
	}

	/// The words the composer chip is drawn with: the tally, then the phase
	/// the run is in.
	///
	/// The chip truncates rather than shedding, so the tally stays at the
	/// leading edge at every width and a narrow window loses the phase name
	/// from its tail instead of losing the numbers.
	#[must_use]
	pub fn chip_text(&self) -> String {
		let tally = self.tally();
		match self.active_phase() {
			Some(phase) => format!("{tally} · {}", phase.name),
			None => tally,
		}
	}
}
