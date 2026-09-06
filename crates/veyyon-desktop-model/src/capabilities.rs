use serde::{Deserialize, Serialize};

/// Enumeration of all thirty protocol capabilities with explicit discriminants.
#[derive(
	Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, strum::EnumIter,
)]
#[repr(u8)]
pub enum Capability {
	Sessions             = 0,
	SessionDeletion      = 1,
	SessionTreeNavigation = 2,
	Transcript           = 3,
	TurnControl          = 4,
	BackgroundSubmission = 5,
	Tools                = 6,
	Approvals            = 7,
	Questions            = 8,
	Plans                = 9,
	Files                = 10,
	Changes              = 11,
	PendingEdits         = 12,
	Terminals            = 13,
	ProcessSupervisor    = 14,
	Models               = 15,
	Providers            = 16,
	Authentication       = 17,
	Mcp                  = 18,
	Extensions           = 19,
	Agents               = 20,
	AgentCommands        = 21,
	Tasks                = 22,
	Settings             = 23,
	Themes               = 24,
	Keybindings          = 25,
	Diagnostics          = 26,
	Usage                = 27,
	ContextBreakdown     = 28,
	Lifecycle            = 29,
}

impl Capability {
	/// Complete list of all capability variants for runtime sweeps.
	pub const ALL: [Self; 30] = [
		Self::Sessions,
		Self::SessionDeletion,
		Self::SessionTreeNavigation,
		Self::Transcript,
		Self::TurnControl,
		Self::BackgroundSubmission,
		Self::Tools,
		Self::Approvals,
		Self::Questions,
		Self::Plans,
		Self::Files,
		Self::Changes,
		Self::PendingEdits,
		Self::Terminals,
		Self::ProcessSupervisor,
		Self::Models,
		Self::Providers,
		Self::Authentication,
		Self::Mcp,
		Self::Extensions,
		Self::Agents,
		Self::AgentCommands,
		Self::Tasks,
		Self::Settings,
		Self::Themes,
		Self::Keybindings,
		Self::Diagnostics,
		Self::Usage,
		Self::ContextBreakdown,
		Self::Lifecycle,
	];

	/// Returns the stable string identifier matching the wire protocol.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Sessions => "Sessions",
			Self::SessionDeletion => "SessionDeletion",
			Self::SessionTreeNavigation => "SessionTreeNavigation",
			Self::Transcript => "Transcript",
			Self::TurnControl => "TurnControl",
			Self::BackgroundSubmission => "BackgroundSubmission",
			Self::Tools => "Tools",
			Self::Approvals => "Approvals",
			Self::Questions => "Questions",
			Self::Plans => "Plans",
			Self::Files => "Files",
			Self::Changes => "Changes",
			Self::PendingEdits => "PendingEdits",
			Self::Terminals => "Terminals",
			Self::ProcessSupervisor => "ProcessSupervisor",
			Self::Models => "Models",
			Self::Providers => "Providers",
			Self::Authentication => "Authentication",
			Self::Mcp => "Mcp",
			Self::Extensions => "Extensions",
			Self::Agents => "Agents",
			Self::AgentCommands => "AgentCommands",
			Self::Tasks => "Tasks",
			Self::Settings => "Settings",
			Self::Themes => "Themes",
			Self::Keybindings => "Keybindings",
			Self::Diagnostics => "Diagnostics",
			Self::Usage => "Usage",
			Self::ContextBreakdown => "ContextBreakdown",
			Self::Lifecycle => "Lifecycle",
		}
	}
}

/// Tri-state capability status reported by host transport.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum CapabilityStatus {
	#[default]
	UnknownUntilAttached,
	Available,
	Unavailable {
		reason: String,
	},
}

/// Fixed array map holding status values for all thirty protocol capabilities.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityMap {
	pub statuses: [CapabilityStatus; 30],
}

impl Default for CapabilityMap {
	fn default() -> Self {
		Self::new()
	}
}

impl CapabilityMap {
	/// Creates a capability map with all capabilities initialized to
	/// `UnknownUntilAttached`.
	#[must_use]
	pub const fn new() -> Self {
		Self {
			statuses: [
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
				CapabilityStatus::UnknownUntilAttached,
			],
		}
	}

	/// Retrieves the status for a given capability.
	#[must_use]
	pub const fn get(&self, capability: Capability) -> &CapabilityStatus {
		let index = capability as usize;
		if index < self.statuses.len() {
			&self.statuses[index]
		} else {
			&CapabilityStatus::UnknownUntilAttached
		}
	}

	/// Sets the status for a given capability.
	pub fn set(&mut self, capability: Capability, status: CapabilityStatus) {
		let index = capability as usize;
		if index < self.statuses.len() {
			self.statuses[index] = status;
		}
	}
}
