//! WHY: a request the right panel sends -- the working tree, a scope switch, a
//! file, the tree -- registers under a control of its own, and the refusal the
//! host answers with lands there carrying the host's sentence and whether the
//! request may be sent again. The projection read that error as a boolean, and
//! read controls that were not the panel's for it:
//!
//! 1. It set `DiffStatus::Failed` or `TreeStatus::Failed` and dropped
//!    everything else, so the panel drew "Failed to load changes" over a
//!    refused working tree, with no reason and no retry, while the request the
//!    host refused was already remembered against the surface the retry keys
//!    on.
//! 2. Among the controls it read was the error scope's fallback one, which for
//!    a change and for a file is the titlebar's line, so any failure the
//!    titlebar owns -- a lost connection, a refused credential, a lifecycle
//!    error -- turned both panes into a failed load of a working tree nothing
//!    had refused.
//!
//! CLASS CLOSED: every action `contextual_surface_for_action` routes to a
//! right-panel control is resolved into the failure the panel states, under
//! both the wire session a request registers with and the row the projection
//! draws, and under nothing else -- a failure on a composer, a queue row, the
//! titlebar or a settings field is neither stated in the panel nor reported as
//! a tab's own load failing. The sweep is over `HostActionKind::iter()`, so an
//! action newly routed to a panel control that no tab reads turns this suite
//! red, and the tabs that state each surface are pinned by exact equality
//! rather than by a count. The failure is resolved every projection and never
//! held, so an error the operator dismissed is gone from the next frame.
//!
//! NOT CAUGHT: where the row is drawn and what it looks like, which is
//! `veyyon-desktop-surface`'s
//! `a-failure-the-host-sent-is-drawn-in-the-panel-it-landed-on.rs`; and which
//! request a press of its Retry sends, which is
//! `a-retry-sends-the-request-the-host-refused.rs`. `retry_control_actions`
//! has no at-rest arm for the panel surfaces, which stays unreachable: the
//! panel draws the row only for a failure that landed, and a failure that
//! landed on a request always leaves that request remembered.

mod support;

use std::collections::BTreeSet;

use strum::IntoEnumIterator as _;
use support::session;
use veyyon_desktop::{SessionIndex, contextual_surface_for_action, land_failure, project_controls};
use veyyon_desktop_model::{
	BackendError, Capability, CapabilityStatus, ErrorScope, HostActionKind, QueuePartition,
	RequestId, RequestRegistry, SessionId, Store, SurfaceId,
};
use veyyon_desktop_surface::{DiffStatus, Intent, PanelTab, ShellState, TreeStatus};

const NOW_MS: u64 = 1_700_000_000_000;

/// The id the host knows the session by, which is what a request registers
/// its control under.
fn wire() -> SessionId {
	SessionId::from("s1")
}

/// A store with one live session open and every capability available, and the
/// index that gives it the row the projection draws.
fn seeded() -> (Store, SessionIndex) {
	let mut store = Store::new();
	store.sessions.insert(session("s1", QueuePartition::Live));
	store.persisted.shell.active_session = Some(wire());
	for capability in Capability::ALL {
		store
			.capabilities
			.set(capability, CapabilityStatus::Available);
	}
	let mut index = SessionIndex::new();
	let _ = index.row_of(&wire());
	(store, index)
}

/// A refusal of `request`, in the host's own words.
fn refusal(request: RequestId, scope: ErrorScope, retryable: bool) -> BackendError {
	BackendError {
		scope,
		code: Some("REFUSED".to_string()),
		message: format!("the host refused the {} request", scope.as_str()),
		retryable,
		request: Some(request),
		occurred_at_ms: NOW_MS,
	}
}

/// Sends `kind` from `surface`, has the host refuse it, and projects the
/// panel on `tab`: the whole path from a registered request to what the panel
/// states, with nothing written into `ShellState` by hand.
fn refused_on(
	tab: PanelTab,
	kind: HostActionKind,
	surface: &SurfaceId,
	scope: ErrorScope,
	retryable: bool,
) -> ShellState {
	let (store, index) = seeded();
	let mut registry = RequestRegistry::new();
	let request = RequestId(1);
	registry.register(request, kind, surface.clone(), NOW_MS, 30_000);

	let mut state = ShellState { current_id: 1, ..ShellState::default() };
	state.panel.tabs = PanelTab::all().to_vec();
	state.panel.active_tab = tab;
	land_failure(&refusal(request, scope, retryable), &registry, Some(&wire()), &mut state);
	// The window completes the request the moment it lands the failure, so a
	// projection reads a control at rest with an error rather than one still
	// pending, which is what decides the tab's own status.
	registry.complete(&request);
	project_controls(&store, &registry, &index, &mut state);
	state
}

/// Every action the window routes to a control of its own, with that control.
fn contextual_actions() -> Vec<(HostActionKind, SurfaceId)> {
	HostActionKind::iter()
		.filter_map(|kind| contextual_surface_for_action(kind, &wire()).map(|id| (kind, id)))
		.collect()
}

/// The scope a panel action's refusal arrives under when the host answers
/// without naming the request.
const fn scope_of(kind: HostActionKind) -> ErrorScope {
	match kind {
		HostActionKind::LoadFileTree | HostActionKind::ReadFile => ErrorScope::File,
		_ => ErrorScope::Change,
	}
}

/// The tabs that state a failure on `surface`, read by projecting each tab.
fn tabs_stating(kind: HostActionKind, surface: &SurfaceId) -> Vec<&'static str> {
	PanelTab::iter()
		.filter(|tab| {
			refused_on(*tab, kind, surface, scope_of(kind), true)
				.panel
				.failure
				.is_some_and(|failure| &failure.surface == surface)
		})
		.map(|tab| tab.slug())
		.collect()
}

/// Every panel control a request can be refused on is read by a tab, and by
/// the tabs recorded here.
///
/// The File tab and the Tree tab share their control because they are two
/// views of one answer: a refused `LoadFileTree` is the reason both are empty.
#[test]
fn every_panel_control_a_request_lands_on_is_stated_by_a_tab() {
	let stated: Vec<(String, Vec<&'static str>)> = contextual_actions()
		.into_iter()
		.map(|(kind, surface)| (format!("{kind:?}"), tabs_stating(kind, &surface)))
		.collect();

	assert_eq!(
		stated,
		vec![
			("LoadFileTree".to_string(), vec!["file", "tree"]),
			("ReadFile".to_string(), vec!["file", "tree"]),
			("RefreshChanges".to_string(), vec!["diff"]),
			("SelectChangeScope".to_string(), vec!["diff"]),
		],
		"every action routed to a panel control is stated by the tabs that answer for it"
	);
}

/// The failure the panel states is the host's sentence, on the control the
/// request went out on, with the offer the host made about it.
#[test]
fn the_panel_states_the_hosts_sentence_and_its_offer() {
	for (kind, surface) in contextual_actions() {
		let scope = scope_of(kind);
		for retryable in [false, true] {
			let tab = if scope == ErrorScope::File {
				PanelTab::File
			} else {
				PanelTab::Diff
			};
			let state = refused_on(tab, kind, &surface, scope, retryable);
			let failure = state
				.panel
				.failure
				.unwrap_or_else(|| panic!("{kind:?} refused on {surface:?} is stated"));
			assert_eq!(
				failure.surface, surface,
				"{kind:?} is stated on the control its request went out on"
			);
			assert_eq!(
				failure.error.message,
				refusal(RequestId(1), scope, retryable).message,
				"{kind:?} is stated in the host's own words"
			);
			assert_eq!(
				failure.error.retryable, retryable,
				"{kind:?} offers to send again exactly when the host said it could"
			);
		}
	}
}

/// A request that registered under the wire session and a projection that
/// draws a row both find the same failure.
#[test]
fn the_failure_is_found_under_the_wire_session_and_under_the_drawn_row() {
	let row = SessionId::from("1");
	for surface in [
		SurfaceId::RightPanelDiffTab(wire()),
		SurfaceId::RightPanelDiffTab(row.clone()),
		SurfaceId::RightPanelChangeScopeSelector(wire()),
		SurfaceId::RightPanelChangeScopeSelector(row),
	] {
		let state = refused_on(
			PanelTab::Diff,
			HostActionKind::RefreshChanges,
			&surface,
			ErrorScope::Change,
			true,
		);
		assert_eq!(
			state.panel.failure.map(|failure| failure.surface),
			Some(surface.clone()),
			"a failure on {surface:?} is the one the Changes tab states"
		);
		assert_eq!(
			state.panel.diff_status,
			DiffStatus::Failed,
			"and the tab's own status still reports the refusal on {surface:?}"
		);
	}
}

/// The tab that is open decides. A refused working tree is not stated over a
/// file the panel did load, and a refused file is not stated over the diff.
#[test]
fn a_tab_states_its_own_failure_and_no_other() {
	let diff_surface = SurfaceId::RightPanelDiffTab(wire());
	let file_surface = SurfaceId::RightPanelFileTab(wire());

	for tab in [PanelTab::File, PanelTab::Tree, PanelTab::Usage] {
		let state =
			refused_on(tab, HostActionKind::RefreshChanges, &diff_surface, ErrorScope::Change, true);
		assert_eq!(state.panel.failure, None, "{tab:?} does not state the working tree's refusal");
		assert_eq!(
			state.panel.diff_status,
			DiffStatus::Failed,
			"{tab:?} leaves the Changes tab's own status reporting it"
		);
	}

	let state =
		refused_on(PanelTab::Diff, HostActionKind::ReadFile, &file_surface, ErrorScope::File, true);
	assert_eq!(state.panel.failure, None, "the Changes tab does not state the file's refusal");
	assert_eq!(
		state.panel.tree.status,
		TreeStatus::Failed,
		"and the tree's own status still reports it"
	);
}

/// The Usage tab reads the control the usage scope lands on.
#[test]
fn the_usage_tab_states_the_usage_refusal() {
	let state = refused_on(
		PanelTab::Usage,
		HostActionKind::GetUsage,
		&SurfaceId::UsageRefreshButton,
		ErrorScope::Usage,
		true,
	);
	assert_eq!(
		state.panel.failure.map(|failure| failure.surface),
		Some(SurfaceId::UsageRefreshButton),
		"the Usage tab states the refusal of the totals it draws"
	);
}

/// The failure is resolved from the controls every projection, never held: a
/// dismissed error is gone from the next frame, and so is one whose control
/// the next projection no longer reads.
#[test]
fn a_dismissed_failure_is_gone_from_the_next_projection() {
	let (store, index) = seeded();
	let surface = SurfaceId::RightPanelDiffTab(wire());
	let mut registry = RequestRegistry::new();
	registry.register(RequestId(1), HostActionKind::RefreshChanges, surface.clone(), NOW_MS, 30_000);

	let mut state = ShellState { current_id: 1, ..ShellState::default() };
	state.panel.tabs = PanelTab::all().to_vec();
	land_failure(
		&refusal(RequestId(1), ErrorScope::Change, true),
		&registry,
		Some(&wire()),
		&mut state,
	);
	registry.complete(&RequestId(1));
	project_controls(&store, &registry, &index, &mut state);
	assert!(state.panel.failure.is_some(), "the refusal is stated while it stands");

	Intent::DismissError(surface).apply(&mut state);
	project_controls(&store, &registry, &index, &mut state);
	assert_eq!(
		state.panel.failure, None,
		"a dismissed refusal is gone from the frame after it, rather than held by the panel"
	);
}

/// Nothing outside the panel's own controls reaches its row: a failure on a
/// composer, a queue row, the titlebar or a settings field is stated where it
/// landed and not in the panel.
#[test]
fn a_failure_outside_the_panel_is_not_stated_in_it() {
	let (store, index) = seeded();
	let outside: BTreeSet<SurfaceId> = [
		SurfaceId::ComposerSendButton(wire()),
		SurfaceId::QueueSessionRow(wire()),
		SurfaceId::GlobalTitlebarLine,
		SurfaceId::DiagnosticRefreshButton,
		SurfaceId::ConnectionRetryButton,
	]
	.into_iter()
	.collect();

	for surface in outside {
		for tab in PanelTab::iter() {
			let mut registry = RequestRegistry::new();
			registry.register(
				RequestId(1),
				HostActionKind::SubmitPrompt,
				surface.clone(),
				NOW_MS,
				30_000,
			);
			let mut state = ShellState { current_id: 1, ..ShellState::default() };
			state.panel.tabs = PanelTab::all().to_vec();
			state.panel.active_tab = tab;
			land_failure(
				&refusal(RequestId(1), ErrorScope::Session, true),
				&registry,
				Some(&wire()),
				&mut state,
			);
			registry.complete(&RequestId(1));
			project_controls(&store, &registry, &index, &mut state);
			assert_eq!(
				state.panel.failure, None,
				"{tab:?} does not state a failure that landed on {surface:?}"
			);
			// And no tab reports it as its own load failing either: the
			// projection used to read the scope's fallback control, which for
			// a change and for a file is the titlebar's line, so any global
			// failure turned both panes into "Failed to load changes".
			assert_ne!(
				state.panel.diff_status,
				DiffStatus::Failed,
				"the Changes tab does not report a failure on {surface:?} as its own"
			);
			assert_ne!(
				state.panel.tree.status,
				TreeStatus::Failed,
				"the Tree tab does not report a failure on {surface:?} as its own"
			);
		}
	}
}
