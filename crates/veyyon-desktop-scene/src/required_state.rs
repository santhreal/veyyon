//! The required state set: every protocol state a scene must exist for,
//! derived from the model's enums at run time so a variant added to the
//! protocol is required here without an edit.

use std::collections::BTreeSet;

use strum::IntoEnumIterator;
pub use veyyon_desktop_kit::PrimitiveKind;
// `ConnectionStateKind` is the model's own fieldless projection of `ConnectionState`,
// re-exported so a consumer of this crate still names one type. A copy declared here would not
// grow when the protocol does, which is the staleness this catalogue exists to catch.
pub use veyyon_desktop_model::ConnectionStateKind;
use veyyon_desktop_model::{
	BadgeKind, BlockKind, Capability, ErrorScope, HostActionKind, MessageRole, QueuePartition,
	action_to_capability,
};

/// Control capability gate availability variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, strum::EnumIter)]
pub enum GateVariant {
	Enabled,
	Pending,
	Unavailable,
	Unknown,
}

/// Row visual presentation shapes in the queue surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, strum::EnumIter)]
pub enum RowShape {
	Card,
	Line,
}

/// Converts a `PascalCase` identifier to a lowercase kebab-case slug.
fn to_kebab_case(s: &str) -> String {
	let mut result = String::with_capacity(s.len() + 4);
	for (i, ch) in s.chars().enumerate() {
		if ch.is_uppercase() {
			if i != 0 {
				result.push('-');
			}
			for lower in ch.to_lowercase() {
				result.push(lower);
			}
		} else {
			result.push(ch);
		}
	}
	result
}

/// Identifies a required state derived from protocol state enumerations.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum RequiredState {
	Connection(ConnectionStateKind),
	CapabilityGate {
		capability: Capability,
		gate:       GateVariant,
	},
	Role(MessageRole),
	Block(BlockKind),
	Error(ErrorScope),
	Badge(BadgeKind),
	Section(QueuePartition),
	/// The rail's derived section: a session holding a prompt the operator
	/// composed and left unsubmitted.
	///
	/// Named on its own because it is the one section no protocol variant
	/// produces. `QueuePartition` holds the four placements a session can be
	/// moved into; the fifth section the rail draws comes from the drafts, so
	/// iterating the protocol reaches four of five and the rail's own enum is
	/// what states there are five. A sixth section turns
	/// `crates/veyyon-desktop/tests/
	/// a-draft-left-in-a-session-is-stated-in-the-rail.rs` red, which sweeps
	/// `Section::all()` against the shipped projection.
	UnsentSection,
	RowShape(RowShape),
	Primitive(PrimitiveKind),
}

impl RequiredState {
	/// Returns the surface identifier this state belongs to.
	#[must_use]
	pub const fn surface(&self) -> &'static str {
		match self {
			Self::Connection(_) => "shell",
			Self::CapabilityGate { .. } => "capability-gate",
			Self::Role(_) => "transcript-role",
			Self::Block(_) => "transcript-block",
			Self::Error(_) => "error-scope",
			Self::Badge(_) => "queue-badge",
			Self::Section(_) | Self::UnsentSection => "queue-section",
			Self::RowShape(_) => "queue-row",
			Self::Primitive(_) => "kit",
		}
	}

	/// Returns the state name slug.
	#[must_use]
	pub fn state_name(&self) -> String {
		match self {
			Self::Connection(k) => format!("connection-{}", to_kebab_case(&format!("{k:?}"))),
			Self::CapabilityGate { capability, gate } => {
				format!(
					"{}-{}",
					to_kebab_case(&format!("{capability:?}")),
					to_kebab_case(&format!("{gate:?}"))
				)
			},
			Self::Role(r) => to_kebab_case(&format!("{r:?}")),
			Self::Block(b) => to_kebab_case(&format!("{b:?}")),
			Self::Error(e) => to_kebab_case(&format!("{e:?}")),
			Self::Badge(b) => to_kebab_case(&format!("{b:?}")),
			Self::Section(s) => to_kebab_case(&format!("{s:?}")),
			Self::UnsentSection => "unsent".to_string(),
			Self::RowShape(r) => to_kebab_case(&format!("{r:?}")),
			Self::Primitive(p) => to_kebab_case(&format!("{p:?}")),
		}
	}

	/// Returns the canonical scene identifier in `surface/state` format.
	#[must_use]
	pub fn scene_name(&self) -> String {
		format!("{}/{}", self.surface(), self.state_name())
	}
}

/// The capabilities at least one host action is gated by.
///
/// `Gate::Pending` exists only while a request of some action is in flight,
/// so a capability no action maps to has no pending state and the catalogue
/// does not require a scene of one. `action_to_capability` is total over
/// `HostActionKind`, so this set grows with the protocol.
#[must_use]
pub fn gated_capabilities() -> BTreeSet<Capability> {
	HostActionKind::iter().map(action_to_capability).collect()
}

/// Derives the complete set of required states from protocol enums.
#[must_use]
pub fn required_states() -> Vec<RequiredState> {
	let gated = gated_capabilities();
	let mut states = Vec::with_capacity(190);
	states.extend(ConnectionStateKind::iter().map(RequiredState::Connection));
	for capability in Capability::iter() {
		for gate in GateVariant::iter() {
			if gate == GateVariant::Pending && !gated.contains(&capability) {
				continue;
			}
			states.push(RequiredState::CapabilityGate { capability, gate });
		}
	}
	states.extend(MessageRole::iter().map(RequiredState::Role));
	states.extend(BlockKind::iter().map(RequiredState::Block));
	states.extend(ErrorScope::iter().map(RequiredState::Error));
	states.extend(BadgeKind::iter().map(RequiredState::Badge));
	states.extend(QueuePartition::iter().map(RequiredState::Section));
	states.push(RequiredState::UnsentSection);
	states.extend(RowShape::iter().map(RequiredState::RowShape));
	states.extend(PrimitiveKind::iter().map(RequiredState::Primitive));
	states
}
