//! From the capability map to what each control may do (§1.2, §4.3).
//!
//! A control never decides its own availability: it reads
//! `ControlStates::availability` and draws what it is told. This is the one
//! place that decision is made, for every control that reads it. A control
//! whose capability the host reported `Unavailable` draws muted with the
//! host's reason; one whose request is in flight draws pending; one the host
//! has not answered for draws at rest, because a disabled control before
//! attach states something false.
//!
//! Every gate is then narrowed by the transport (`transport_gate`, §8.12),
//! because the capability map holds what the host declared while it was
//! reachable and says nothing about whether it still is.
mod gates;

use veyyon_desktop_model::{
	Capability, CapabilityStatus, HostActionKind, RequestRegistry, Store, SurfaceId, gate_kind,
};
use veyyon_desktop_surface::{
	Availability, DiffStatus, DrawerFailure, PanelFailure, PanelTab, SettingsFailure, ShellState,
	TreeStatus,
};

use self::gates::{composer_controls, composer_row};
pub use self::gates::{contextual_surface_for_action, gated_controls, session_row_controls};
use super::{
	SessionIndex,
	connection::{transport_gate, transport_gate_capability},
};

/// What the composer's controls read while no session is open: the intent
/// path sends nothing for them (`actions_for`), so the control states that
/// rather than drawing at rest.
pub const NO_SESSION_OPEN: &str = "no session is open";

/// Sets every gated control's availability from the capability map and the
/// in-flight registry.
///
/// The registry is the one source of a pending mark, so a request the host
/// answered releases its control on the next projection. Every availability
/// the last projection set is dropped first, so a value it no longer states
/// is gone rather than read by the next frame: the row that stopped being
/// the active one keeps no gate from when it was. With no session open the
/// composer still draws, under the row id of no session, and its controls
/// are unavailable for that reason rather than unset.
pub fn project_controls(
	store: &Store,
	registry: &RequestRegistry,
	index: &SessionIndex,
	state: &mut ShellState,
) {
	state.controls.clear_availability();
	let active_row = store
		.persisted
		.shell
		.active_session
		.as_ref()
		.and_then(|id| index.row_id(id));
	for (surface, action) in gated_controls(store, index, active_row) {
		let gate = transport_gate(
			action,
			&store.connection,
			gate_kind(action, &store.capabilities, registry),
		);
		state
			.controls
			.set_availability(surface, Availability::from(gate));
	}
	if let Some(active_id) = store.persisted.shell.active_session.as_ref()
		&& let Some(row_id) = active_row
	{
		let row = composer_row(Some(row_id));
		if let Some(pending) = store.interactions.get(active_id) {
			if let Some(question) = pending.questions.first() {
				let gate = transport_gate(
					HostActionKind::RespondToInteraction,
					&store.connection,
					veyyon_desktop_model::gate_capability(
						Capability::Questions,
						&store.capabilities,
						registry,
					),
				);
				state.controls.set_availability(
					SurfaceId::QuestionSubmitButton(row.clone(), question.id.clone()),
					Availability::from(gate),
				);
			}
			if let Some(plan) = pending.plans.first() {
				let gate = transport_gate(
					HostActionKind::RespondToInteraction,
					&store.connection,
					veyyon_desktop_model::gate_capability(
						Capability::Plans,
						&store.capabilities,
						registry,
					),
				);
				state.controls.set_availability(
					SurfaceId::PlanAcceptButton(row.clone(), plan.id.clone()),
					Availability::from(gate.clone()),
				);
				state.controls.set_availability(
					SurfaceId::PlanRefineButton(row, plan.id.clone()),
					Availability::from(gate),
				);
			}
		}
	}
	let ext_gate = transport_gate_capability(
		&store.connection,
		veyyon_desktop_model::gate_capability(
			veyyon_desktop_model::Capability::Extensions,
			&store.capabilities,
			registry,
		),
	);
	state.controls.set_availability(
		SurfaceId::SettingsField("extensions".to_string()),
		Availability::from(ext_gate),
	);
	if matches!(
		store.capabilities.get(Capability::BackgroundSubmission),
		CapabilityStatus::Unavailable { .. }
	) && let Some(row_id) = active_row
	{
		let row = composer_row(Some(row_id));
		state
			.controls
			.set_availability(SurfaceId::ComposerQueueModeToggle(row), Availability::Unavailable {
				reason: "background submission unavailable".to_string(),
			});
	}
	if active_row.is_none() {
		let row = composer_row(active_row);
		for (surface, _) in composer_controls(&row) {
			state
				.controls
				.set_availability(surface, Availability::Unavailable {
					reason: NO_SESSION_OPEN.to_string(),
				});
		}
		for surface in [
			SurfaceId::RightPanelDiffTab(row.clone()),
			SurfaceId::RightPanelFileTab(row.clone()),
			SurfaceId::RightPanelChangeScopeSelector(row),
		] {
			state
				.controls
				.set_availability(surface, Availability::Unavailable {
					reason: NO_SESSION_OPEN.to_string(),
				});
		}
	}

	let active_id = store.persisted.shell.active_session.as_ref();
	let row = composer_row(active_row);
	// Contextual status resolution for Changes / Diff
	let diff_pending = registry
		.find_pending_for_action(HostActionKind::RefreshChanges)
		.is_some()
		|| registry
			.find_pending_for_capability(Capability::Changes)
			.is_some();
	let has_changes = store.domains.changes.is_some();
	let diff_unavailable =
		matches!(store.capabilities.get(Capability::Changes), CapabilityStatus::Unavailable { .. });
	// A request registers under the session id the host uses, the projection
	// reads the row the queue draws, and a scope switch lands on the selector
	// rather than the tab, so the failure is looked for under each of them in
	// turn and the first one found is the tab's.
	//
	// The scope's fallback control is not one of them: `ErrorScope::Change`
	// falls back to the titlebar's line, so reading it here made every
	// failure the titlebar owns -- a lost connection, a refused credential,
	// a lifecycle error -- report as "Failed to load changes" over a working
	// tree the panel had loaded and no request had refused.
	let mut diff_surfaces = vec![
		SurfaceId::RightPanelDiffTab(row.clone()),
		SurfaceId::RightPanelChangeScopeSelector(row.clone()),
	];
	if let Some(session) = active_id {
		diff_surfaces.push(SurfaceId::RightPanelDiffTab(session.clone()));
		diff_surfaces.push(SurfaceId::RightPanelChangeScopeSelector(session.clone()));
	}
	let diff_failure = first_failure(state, &diff_surfaces);

	state.panel.diff_status = if diff_pending {
		DiffStatus::Loading
	} else if has_changes {
		DiffStatus::Loaded
	} else if diff_unavailable || diff_failure.is_some() {
		DiffStatus::Failed
	} else {
		DiffStatus::Unloaded
	};

	// Contextual status resolution for FileTree / Tree
	let tree_pending = registry
		.find_pending_for_action(HostActionKind::LoadFileTree)
		.is_some()
		|| registry
			.find_pending_for_capability(Capability::Files)
			.is_some();
	let has_tree = store.domains.file_tree.is_some();
	let tree_unavailable =
		matches!(store.capabilities.get(Capability::Files), CapabilityStatus::Unavailable { .. });
	let mut file_surfaces = vec![SurfaceId::RightPanelFileTab(row)];
	if let Some(session) = active_id {
		file_surfaces.push(SurfaceId::RightPanelFileTab(session.clone()));
	}
	// No fallback here either: `ErrorScope::File`'s is the titlebar's line.
	let file_failure = first_failure(state, &file_surfaces);

	state.panel.tree.status = if tree_pending {
		TreeStatus::Loading
	} else if has_tree {
		TreeStatus::Loaded
	} else if tree_unavailable || file_failure.is_some() {
		TreeStatus::Failed
	} else {
		TreeStatus::Unloaded
	};

	// The panel draws one tab, so it states that tab's failure and no other:
	// a File tab open while the working tree was refused would otherwise
	// carry the diff's error over the document it did load.
	state.panel.failure = match state.panel.active_tab {
		PanelTab::Diff => diff_failure,
		PanelTab::File | PanelTab::Tree => file_failure,
		PanelTab::Usage => first_failure(state, &[SurfaceId::UsageRefreshButton]),
	};
	// §4.4: the drawer states the refusal any of its own controls landed on,
	// resolved from what the failure is rather than from a control named
	// here, so a control the drawer grows is stated by what it is. The
	// drawer read one control -- the terminal its own opening creates -- so
	// a refused start, a line the host could not write and a process it
	// could not stop each reached nothing that draws.
	let drawer_failure = state
		.controls
		.failures()
		.find(|(surface, _)| surface.in_terminal_drawer())
		.map(|(surface, error)| DrawerFailure { surface: surface.clone(), error: error.clone() });
	state.drawer.failure = drawer_failure;
	// §4.4: the sheet states the refusal any of its own controls landed on,
	// resolved the same way -- by what the failure is rather than by a
	// control named here -- so a page the sheet grows states its refusals by
	// being on the sheet. Every page stated nothing of its own, so a setting
	// the host would not write was reported on the window's line above the
	// sheet and a sign-in it refused reached nothing that draws.
	let settings_failure = state
		.controls
		.failures()
		.find(|(surface, _)| surface.in_settings_sheet())
		.map(|(surface, error)| SettingsFailure { surface: surface.clone(), error: error.clone() });
	if let Some(settings) = state.overlay_settings_mut() {
		settings.failure = settings_failure;
	}
}

/// The first of these controls carrying a failure, as the panel states it.
///
/// One request registers under one surface, so at most one of a tab's
/// candidates holds an error in practice; the order is what decides when a
/// stale fallback and a fresh contextual failure are both set.
fn first_failure(state: &ShellState, surfaces: &[SurfaceId]) -> Option<PanelFailure> {
	surfaces.iter().find_map(|surface| {
		state
			.controls
			.error(surface)
			.map(|error| PanelFailure { surface: surface.clone(), error: error.clone() })
	})
}
