//! The store the settings sheet draws from, and the sweep of every request
//! its pages send, for the suite that drives what the sheet states when the
//! host refuses one.

use veyyon_desktop::{SessionIndex, actions_for, surface_for_action};
use veyyon_desktop_model::{
	AgentView, AuthFlowState, AuthFlowView, Capability, CapabilityStatus, HostAction,
	KeybindingView, McpServerStatus, McpServerView, ProviderView, QueuePartition, SessionId,
	SettingEntry, SettingKind, SettingsView, Store, SurfaceId, action_to_capability,
};

use super::{intent_samples::every_sample_intent, session};

/// The id the host knows the session by.
pub fn wire() -> SessionId {
	SessionId::from("s1")
}

/// The row the window draws that session under, which session-scoped
/// requests register against.
pub fn row() -> SessionId {
	SessionId::from("1")
}

/// Whether an action belongs to a family the settings sheet draws controls
/// for. Read from the capability rather than from a list of actions, so an
/// action added to one of these families is swept by what it is.
pub const fn on_the_sheet(capability: Capability) -> bool {
	matches!(
		capability,
		Capability::Settings
			| Capability::Themes
			| Capability::Keybindings
			| Capability::Diagnostics
			| Capability::Mcp
			| Capability::Agents
			| Capability::Tasks
			| Capability::Providers
			| Capability::Authentication
			| Capability::Usage
			| Capability::ContextBreakdown
	)
}

/// One setting, as the host reports it.
fn setting(value: &str) -> SettingEntry {
	SettingEntry {
		value:       serde_json::json!(value),
		default:     serde_json::json!("light"),
		source:      "profile".to_string(),
		kind:        SettingKind::String,
		label:       None,
		description: None,
		tab:         None,
		group:       None,
		values:      Vec::new(),
		options:     Vec::new(),
		min:         None,
		max:         None,
		global:      false,
		advanced:    false,
		hidden:      false,
	}
}

/// One background agent, as the host reports it.
fn agent(id: &str) -> AgentView {
	AgentView {
		id:           id.to_string(),
		display_name: id.to_string(),
		kind:         "task".to_string(),
		status:       "running".to_string(),
		parent:       None,
		scope:        "/repo".to_string(),
		session:      None,
	}
}

/// A store the sheet has something to draw on every page: one setting, one
/// binding, one provider, one server, the two agents the sample retries name,
/// and a diagnostic source in error, with every capability available.
pub fn seeded() -> (Store, SessionIndex) {
	let mut store = Store::new();
	store.sessions.insert(session("s1", QueuePartition::Live));
	store.persisted.shell.active_session = Some(wire());
	for capability in Capability::ALL {
		store
			.capabilities
			.set(capability, CapabilityStatus::Available);
	}
	let mut settings = SettingsView::new();
	settings.insert("theme".to_string(), setting("dark"));
	store.domains.settings = Some(settings);
	store.domains.keybindings = vec![KeybindingView {
		action: "composer.send".to_string(),
		keys:   vec!["ctrl-enter".to_string()],
		source: "user".to_string(),
	}];
	store.domains.providers = vec![ProviderView {
		id:            "anthropic".to_string(),
		name:          "Anthropic".to_string(),
		authenticated: false,
		oauth:         true,
		api_key:       true,
	}];
	// A sign-in the operator started and has not finished, which is the
	// state the cancel and the retry are reachable in: both read the
	// provider off the flow, so without one they name nobody.
	store.domains.auth_flow = Some(AuthFlowView {
		provider: "anthropic".to_string(),
		state:    AuthFlowState::AwaitingSecret,
		url:      Some("https://auth.example.com".to_string()),
		prompt:   None,
		message:  None,
	});
	store.domains.mcp = vec![McpServerView {
		name:    "mcp-server".to_string(),
		enabled: true,
		status:  McpServerStatus::Connected,
		tools:   Vec::new(),
	}];
	store.domains.agents = vec![agent("agent-1"), agent("task-1")];
	store.domains.diagnostics = Some(serde_json::json!({
		"sources": [{ "name": "cargo", "status": "error", "message": "no toolchain" }]
	}));
	let mut index = SessionIndex::new();
	let _ = index.row_of(&wire());
	(store, index)
}

/// Every action a sample intent sends that belongs to one of the sheet's
/// capabilities, with the control the window registers it under.
pub fn sheet_requests() -> Vec<(HostAction, SurfaceId)> {
	let mut requests = Vec::new();
	for intent in every_sample_intent() {
		let (mut store, index) = seeded();
		for action in actions_for(&intent, &index, &mut store) {
			if !on_the_sheet(action_to_capability(action.kind())) {
				continue;
			}
			let surface = surface_for_action(&intent, &action, Some(&row()));
			requests.push((action, surface));
		}
	}
	assert!(
		requests.len() >= 15,
		"the sheet's intents reached {} actions, so the sweep is not driving them: {requests:?}",
		requests.len()
	);
	requests
}

/// What a sheet action acts on: a setting by its key, a binding by its
/// action, a server by its name, a source by its name, a sign-in by its
/// provider, an agent or a task by its id.
pub fn target_of_action(action: &HostAction) -> Option<&str> {
	match action {
		HostAction::SetSetting { key, .. } | HostAction::ResetSetting { key } => Some(key),
		HostAction::SetKeybinding { action, .. } => Some(action),
		HostAction::SetMcpEnabled { server, .. } => Some(server),
		HostAction::RetryDiagnosticSource { source } => Some(source),
		HostAction::StartProviderAuth { provider }
		| HostAction::SubmitAuthSecret { provider, .. }
		| HostAction::CancelAuthFlow { provider }
		| HostAction::RetryAuthFlow { provider } => Some(provider),
		HostAction::OpenAuthUrl { url } => Some(url),
		HostAction::ReviveAgent { agent_id } => Some(agent_id),
		HostAction::CancelTask { task_id } => Some(task_id),
		_ => None,
	}
}

/// The control family a sheet surface belongs to, and what it is keyed under
/// for the families that name something.
pub fn sheet_control(surface: &SurfaceId) -> (&'static str, Option<&str>) {
	match surface {
		SurfaceId::SettingsField(key) => ("SettingsField", Some(key)),
		SurfaceId::ThemeSelector => ("ThemeSelector", None),
		SurfaceId::KeybindingField(action) => ("KeybindingField", Some(action)),
		SurfaceId::McpEnableToggle(server) => ("McpEnableToggle", Some(server)),
		SurfaceId::DiagnosticRefreshButton => ("DiagnosticRefreshButton", None),
		SurfaceId::DiagnosticRetrySourceButton(source) => {
			("DiagnosticRetrySourceButton", Some(source))
		},
		SurfaceId::UsageRefreshButton => ("UsageRefreshButton", None),
		SurfaceId::ContextBreakdownRefreshButton => ("ContextBreakdownRefreshButton", None),
		SurfaceId::TaskSpawnButton => ("TaskSpawnButton", None),
		SurfaceId::TaskCancelButton(task) => ("TaskCancelButton", Some(task)),
		SurfaceId::AgentReviveButton(agent) => ("AgentReviveButton", Some(agent)),
		SurfaceId::ProviderAuthStartButton(provider) => ("ProviderAuthStartButton", Some(provider)),
		SurfaceId::ProviderAuthSecretSubmit(provider) => ("ProviderAuthSecretSubmit", Some(provider)),
		SurfaceId::ProviderAuthUrlOpen(url) => ("ProviderAuthUrlOpen", Some(url)),
		SurfaceId::ProviderAuthCancelButton(provider) => ("ProviderAuthCancelButton", Some(provider)),
		SurfaceId::ProviderAuthRetryButton(provider) => ("ProviderAuthRetryButton", Some(provider)),
		_ => ("outside the sheet", None),
	}
}
