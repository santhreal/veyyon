//! From the capability map to what each control may do (§1.2, §4.3).
//!
//! A control never decides its own availability: it reads
//! `ControlStates::availability` and draws what it is told. This is the one
//! place that decision is made, for every control that reads it, by the same
//! `gate_kind` the intent path consults before sending. A control whose
//! capability the host reported `Unavailable` draws muted with the host's
//! reason; one whose request is in flight draws pending; one the host has not
//! answered for draws at rest, because a disabled control before attach states
//! something false.
//!
//! The composer keys its controls by the queue row id, not the host's session
//! id, so the active row's id is taken from the index rather than the store.

use veyyon_desktop_model::{
	HostActionKind, RequestRegistry, SessionId, Store, SurfaceId, gate_kind,
};
use veyyon_desktop_surface::{Availability, ShellState};

use super::SessionIndex;

/// The row the composer draws for: the active session's, or zero when none
/// is open, which is the id of no session and the id the composer reads.
fn composer_row(active_row: Option<u64>) -> SessionId {
	SessionId::from(active_row.unwrap_or(0).to_string())
}

/// The composer's own controls, with the action each would send.
fn composer_controls(row: &SessionId) -> [(SurfaceId, HostActionKind); 7] {
	[
		(SurfaceId::ComposerSendButton(row.clone()), HostActionKind::SubmitPrompt),
		(SurfaceId::ComposerSteerButton(row.clone()), HostActionKind::Steer),
		(SurfaceId::ComposerQueueButton(row.clone()), HostActionKind::FollowUp),
		(SurfaceId::ComposerAbortButton(row.clone()), HostActionKind::AbortTurn),
		(SurfaceId::ComposerQueueModeToggle(row.clone()), HostActionKind::SetQueueMode),
		(SurfaceId::ComposerModelSelector(row.clone()), HostActionKind::SelectModel),
		(SurfaceId::ComposerThinkingSelector(row.clone()), HostActionKind::SetThinkingLevel),
	]
}

/// Every control that reads its availability, with the action it would send.
///
/// Derived from the store's domains at each projection, so a provider, server,
/// setting or binding the host adds on the next snapshot is gated on the frame
/// that shows it. The composer's primary action answers the first pending
/// card of each kind under that card's id (`TurnPhase::primary_surface`), so
/// those ids are gated by the answer they would send.
fn gated_controls(store: &Store, active_row: Option<u64>) -> Vec<(SurfaceId, HostActionKind)> {
	let mut controls = vec![
		(SurfaceId::ThemeSelector, HostActionKind::LoadThemes),
		(SurfaceId::DiagnosticRefreshButton, HostActionKind::RefreshDiagnostics),
		(SurfaceId::UsageRefreshButton, HostActionKind::GetUsage),
		(SurfaceId::ContextBreakdownRefreshButton, HostActionKind::GetContextBreakdown),
	];

	if active_row.is_some() {
		let row = composer_row(active_row);
		controls.extend(composer_controls(&row));
		let pending = store
			.persisted
			.shell
			.active_session
			.as_ref()
			.and_then(|id| store.interactions.get(id));
		if let Some(pending) = pending {
			let answer = HostActionKind::RespondToInteraction;
			controls.extend(pending.approvals.first().map(|approval| {
				(SurfaceId::ApprovalApproveButton(row.clone(), approval.id.clone()), answer)
			}));
			controls.extend(pending.questions.first().map(|question| {
				(SurfaceId::QuestionSubmitButton(row.clone(), question.id.clone()), answer)
			}));
			controls.extend(pending.plans.first().into_iter().flat_map(|plan| {
				[
					(SurfaceId::PlanAcceptButton(row.clone(), plan.id.clone()), answer),
					(SurfaceId::PlanRefineButton(row.clone(), plan.id.clone()), answer),
				]
			}));
		}
	}

	let domains = &store.domains;
	if let Some(settings) = &domains.settings {
		controls.extend(
			settings
				.keys()
				.map(|key| (SurfaceId::SettingsField(key.clone()), HostActionKind::SetSetting)),
		);
	}
	controls.extend(domains.keybindings.iter().map(|binding| {
		(SurfaceId::KeybindingField(binding.action.clone()), HostActionKind::SetKeybinding)
	}));
	controls.extend(domains.providers.iter().map(|provider| {
		(SurfaceId::ProviderAuthStartButton(provider.id.clone()), HostActionKind::StartProviderAuth)
	}));
	controls.extend(domains.mcp.iter().map(|server| {
		(SurfaceId::McpEnableToggle(server.name.clone()), HostActionKind::SetMcpEnabled)
	}));
	controls
}

/// What the composer's controls read while no session is open: the intent
/// path sends nothing for them (`actions_for`), so the control states that
/// rather than drawing at rest.
pub const NO_SESSION_OPEN: &str = "no session is open";

/// Sets every gated control's availability from the capability map and the
/// in-flight registry.
///
/// The registry is the one source of a pending mark, so a request the host
/// answered releases its control on the next projection. With no session
/// open the composer still draws, under the row id of no session, and its
/// controls are unavailable for that reason rather than unset.
pub fn project_controls(
	store: &Store,
	registry: &RequestRegistry,
	index: &SessionIndex,
	state: &mut ShellState,
) {
	let active_row = store
		.persisted
		.shell
		.active_session
		.as_ref()
		.and_then(|id| index.row_id(id));
	for (surface, action) in gated_controls(store, active_row) {
		let gate = gate_kind(action, &store.capabilities, registry);
		state
			.controls
			.set_availability(surface, Availability::from(gate));
	}
	if active_row.is_none() {
		for (surface, _) in composer_controls(&composer_row(active_row)) {
			state
				.controls
				.set_availability(surface, Availability::Unavailable {
					reason: NO_SESSION_OPEN.to_string(),
				});
		}
	}
}
