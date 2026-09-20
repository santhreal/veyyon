//! Goal mode domain types (§5, §8).

use serde::{Deserialize, Serialize};

use crate::action::GoalControl;

/// Execution status of an autonomous goal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
	Active,
	Paused,
	BudgetLimited,
	Complete,
	Dropped,
}

impl GoalStatus {
	/// Returns the stable string identifier matching the wire protocol.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Active => "active",
			Self::Paused => "paused",
			Self::BudgetLimited => "budget_limited",
			Self::Complete => "complete",
			Self::Dropped => "dropped",
		}
	}

	/// Human-readable label stating the status.
	#[must_use]
	pub const fn label(self) -> &'static str {
		match self {
			Self::Active => "Active",
			Self::Paused => "Paused",
			Self::BudgetLimited => "Budget limited",
			Self::Complete => "Complete",
			Self::Dropped => "Dropped",
		}
	}

	/// Controls permitted on the goal card while in this status.
	#[must_use]
	pub const fn allowed_controls(self) -> &'static [GoalControl] {
		match self {
			Self::Active => &[GoalControl::Pause, GoalControl::Drop],
			Self::Paused | Self::BudgetLimited => &[GoalControl::Resume, GoalControl::Drop],
			Self::Complete => &[GoalControl::Drop],
			Self::Dropped => &[],
		}
	}
}

/// Snapshot view of an autonomous goal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoalView {
	pub objective:         String,
	pub status:            GoalStatus,
	/// The host is opening continuation turns for this goal right now.
	pub driving:           bool,
	pub tokens_used:       u64,
	pub token_budget:      Option<u64>,
	pub turns_completed:   u64,
	pub time_used_seconds: u64,
	pub created_at_ms:     u64,
	pub updated_at_ms:     u64,
	/// Why the host stopped driving, in the operator's words; `None` while it
	/// drives.
	pub stood_down:        Option<String>,
}

impl GoalView {
	/// Returns compact status text for the composer footer chip at full width.
	#[must_use]
	pub fn chip_text(&self) -> String {
		let turns = if self.turns_completed == 1 {
			"1 turn".to_string()
		} else {
			format!("{} turns", self.turns_completed)
		};
		format!("Goal: {} · {turns}", self.status.label())
	}

	/// Returns status text for the composer footer chip, shedding detail as the
	/// available width narrows (§5.4, §5.7):
	/// - Wide (>= 640px): `Goal: <Status> · <N> turns`
	/// - Compact (>= 480px): `Goal: <Status>` (sheds turn count)
	/// - Narrow (< 480px): `Goal` (sheds status word, leaving anchor)
	#[must_use]
	pub fn chip_text_for_width(&self, width: f32) -> String {
		let label = self.status.label();
		if width < 480.0 {
			"Goal".to_string()
		} else if width < 640.0 {
			format!("Goal: {label}")
		} else {
			self.chip_text()
		}
	}
}
