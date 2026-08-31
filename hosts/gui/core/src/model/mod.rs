//! Typed engine replica values.
//!
//! A [`Replica`] is changed only by `Store::apply`. Views and UI commands read
//! it but never mutate authoritative payloads.

mod agent;
mod attachment;
mod connection;
mod diagnostic;
mod file;
mod ids;
mod mcp;
mod notification;
mod provider;
mod remote;
mod session;
mod settings;
mod terminal;
mod tool;
mod transcript;
mod value;

use std::collections::BTreeMap;

pub use agent::*;
pub use attachment::*;
pub use connection::*;
pub use diagnostic::*;
pub use file::*;
pub use ids::*;
pub use mcp::*;
pub use notification::*;
pub use provider::*;
pub use remote::*;
pub use session::*;
pub use settings::*;
pub use terminal::*;
pub use tool::*;
pub use transcript::*;
pub use value::*;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Replica {
	pub workspaces:        RemoteData<Versioned<Vec<WorkspaceView>>>,
	pub sessions:          SessionIndexReplica,
	pub active_session:    RemoteData<Versioned<SessionHeaderView>>,
	pub transcript:        RemoteData<Versioned<Vec<TranscriptEntry>>>,
	pub transcript_paging: RemoteData<Versioned<TranscriptPagingState>>,
	pub streaming:         Option<StreamingMessageState>,
	pub runtime:           RemoteData<Versioned<SessionRuntimeView>>,
	pub tools:             RemoteData<Versioned<Vec<ToolCallView>>>,
	pub interactions:      RemoteData<Versioned<Vec<InteractionRequest>>>,
	pub plan:              RemoteData<Versioned<PlanState>>,
	pub files:             RemoteData<Versioned<FileWorkspaceState>>,
	pub changes:           RemoteData<Versioned<ChangesSnapshot>>,
	pub terminals:         RemoteData<Versioned<Vec<TerminalRunView>>>,
	pub processes:         ProcessSupervisorState,
	pub output:            RemoteData<Versioned<Vec<OutputRecord>>>,
	pub models:            RemoteData<Versioned<ModelCatalogState>>,
	pub providers:         RemoteData<Versioned<Vec<ProviderView>>>,
	pub auth:              RemoteData<Versioned<AuthState>>,
	pub mcp:               RemoteData<Versioned<McpState>>,
	pub extensions:        RemoteData<Versioned<ExtensionRegistryState>>,
	pub agents:            RemoteData<Versioned<AgentRosterState>>,
	pub tasks:             RemoteData<Versioned<Vec<TaskView>>>,
	pub settings:          RemoteData<Versioned<SettingsState>>,
	pub themes:            RemoteData<Versioned<ThemeState>>,
	pub keybindings:       RemoteData<Versioned<KeybindingState>>,
	pub diagnostics:       RemoteData<Versioned<DiagnosticsSnapshot>>,
	pub usage:             RemoteData<Versioned<UsageSnapshot>>,
	pub context:           RemoteData<Versioned<ContextSnapshot>>,
	pub lifecycle:         RemoteData<Versioned<LifecycleState>>,
	pub capabilities:      BTreeMap<Capability, CapabilityStatus>,
	pub errors:            Vec<BackendError>,
	pub notifications:     NotificationQueue,
}

impl Default for Replica {
	fn default() -> Self {
		Self {
			workspaces:        RemoteData::Unrequested,
			sessions:          SessionIndexReplica::default(),
			active_session:    RemoteData::Unrequested,
			transcript:        RemoteData::Unrequested,
			transcript_paging: RemoteData::Unrequested,
			streaming:         None,
			runtime:           RemoteData::Unrequested,
			tools:             RemoteData::Unrequested,
			interactions:      RemoteData::Unrequested,
			plan:              RemoteData::Unrequested,
			files:             RemoteData::Unrequested,
			changes:           RemoteData::Unrequested,
			terminals:         RemoteData::Unrequested,
			processes:         ProcessSupervisorState {
				processes:   RemoteData::Unrequested,
				completions: Vec::new(),
			},
			output:            RemoteData::Unrequested,
			models:            RemoteData::Unrequested,
			providers:         RemoteData::Unrequested,
			auth:              RemoteData::Unrequested,
			mcp:               RemoteData::Unrequested,
			extensions:        RemoteData::Unrequested,
			agents:            RemoteData::Unrequested,
			tasks:             RemoteData::Unrequested,
			settings:          RemoteData::Unrequested,
			themes:            RemoteData::Unrequested,
			keybindings:       RemoteData::Unrequested,
			diagnostics:       RemoteData::Unrequested,
			usage:             RemoteData::Unrequested,
			context:           RemoteData::Unrequested,
			lifecycle:         RemoteData::Unrequested,
			capabilities:      BTreeMap::new(),
			errors:            Vec::new(),
			notifications:     NotificationQueue::default(),
		}
	}
}

impl Replica {
	pub fn capability(&self, capability: Capability) -> &CapabilityStatus {
		self
			.capabilities
			.get(&capability)
			.unwrap_or(&CapabilityStatus::UnknownUntilAttached)
	}
}
#[cfg(test)]
mod every_failure_reporting_store_field_produces_a_notification;
#[cfg(test)]
mod the_notification_queue_dedupes_bounds_and_expires_by_frame_time;
