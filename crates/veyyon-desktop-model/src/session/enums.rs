//! Operational mode, placement partition, and badge enumerations for session
//! state.

use serde::{Deserialize, Serialize};

/// The partition the operator put a session in (§0).
#[derive(
	Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, strum::EnumIter,
)]
pub enum QueuePartition {
	Pinned,
	Live,
	Deferred,
	Parked,
}

impl QueuePartition {
	/// Complete slice of all four placements.
	pub const ALL: [Self; 4] = [Self::Pinned, Self::Live, Self::Deferred, Self::Parked];
}

/// Status badges indicating operational state or required operator attention.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, strum::EnumDiscriminants)]
#[strum_discriminants(name(BadgeKind), derive(Hash, PartialOrd, Ord, strum::EnumIter))]
#[strum_discriminants(
	doc = "Fieldless projection of `SessionBadge`, so a scene gate can sweep every badge."
)]
pub enum SessionBadge {
	Approval,
	Input,
	Plan,
	Failed,
	Due,
	Done,
	Working { started_at_ms: u64 },
	Watching,
}

/// A mode the operator sets from the window, in the spelling the host accepts.
///
/// Narrower than `SessionMode` on purpose: `goal` runs turns of its own from a
/// controller no desktop gesture reaches, and `plan_paused` is the agent's,
/// A mode the operator sets from the window in host wire spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum SettableMode {
	/// Plan mode: read-only tools and a plan the operator resolves.
	Plan,
	/// Vibe mode: the agent reads and directs worker sessions that do the rest.
	Vibe,
	/// Loop mode: repeats the last prompt.
	Loop,
	/// No mode: the agent runs with everything it has.
	None,
}

/// The mode a session runs in, as the host states it on the session's header.
///
/// A mode decides which tools the agent holds and how its turn ends, so it is
/// state the window states rather than one the operator infers from a card
/// that happens to be up. `Other` carries a name this client has no spelling
/// for, so a host that adds a mode is drawn rather than dropped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, strum::EnumDiscriminants)]
#[strum_discriminants(name(SessionModeKind), derive(Hash, PartialOrd, Ord, strum::EnumIter))]
#[strum_discriminants(doc = "Fieldless projection of `SessionMode`, so a sweep reads the modes \
                             this client spells from the enum rather than from a list beside it.")]
pub enum SessionMode {
	Plan,
	PlanPaused,
	Goal,
	Vibe,
	Loop,
	Other(String),
}

impl SessionMode {
	/// The mode a host-reported name states, or `None` for the absence of one.
	///
	/// `none` is how the host spells a session in no mode, and an empty name is
	/// the same absence written by a host that sends the field empty rather
	/// than omitting it.
	#[must_use]
	pub fn from_wire(name: &str) -> Option<Self> {
		match name {
			"none" | "" => None,
			"plan" => Some(Self::Plan),
			"plan_paused" => Some(Self::PlanPaused),
			"goal" => Some(Self::Goal),
			"vibe" => Some(Self::Vibe),
			"loop" => Some(Self::Loop),
			other => Some(Self::Other(other.to_owned())),
		}
	}

	/// The name the host states this mode by, which is what an action setting
	/// it sends back.
	#[must_use]
	pub fn wire_name(&self) -> &str {
		match self {
			Self::Plan => "plan",
			Self::PlanPaused => "plan_paused",
			Self::Goal => "goal",
			Self::Vibe => "vibe",
			Self::Loop => "loop",
			Self::Other(name) => name,
		}
	}

	/// What the window calls this mode where it states it.
	#[must_use]
	pub fn label(&self) -> &str {
		match self {
			Self::Plan => "Plan mode",
			Self::PlanPaused => "Plan paused",
			Self::Goal => "Goal mode",
			Self::Vibe => "Vibe mode",
			Self::Loop => "Loop mode",
			Self::Other(name) => name,
		}
	}
}
