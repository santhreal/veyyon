//! WHY: a queue row menu opens on the row under the pointer and reads the gate
//! of that row's session (`card_row_answers`), but the projection set those
//! gates for the active session alone and never dropped a value it stopped
//! stating. Two failures followed. A row that had been active kept whatever
//! the last projection that owned it wrote: a capture caught `Export`,
//! `Compact` and `Handoff` drawn refused with the shortcut "In flight..." on a
//! row whose `CreateSession` request had been answered a minute earlier,
//! because the projection that owned that row ran while the request was in
//! flight and nothing overwrote it. A row that had never been active read no
//! gate at all, and an unset id reads at rest, so the menu offered answers the
//! host had refused.
//!
//! CLASS CLOSED:
//! 1. Any answer the row menu offers reading a gate the projection does not own
//!    for that row. The suite sweeps `card_row_answers`, so an answer added to
//!    that table is covered by being in it, and turns this red until
//!    `session_row_controls` gains its surface.
//! 2. Any availability outliving the projection that stated it, for every
//!    surface a row owns: the pass clears what it no longer states, and a
//!    session the host stopped listing leaves nothing behind.
//! 3. A refusal reaching the active row alone. Every session in the store is
//!    swept, so a gate that lands on one row and not its siblings is red.
//!
//! NOT CAUGHT: how a refused answer draws — opacity, cursor, the "In
//! flight..." shortcut — which is `availability_style` and the row menu suites
//! in `veyyon-desktop-surface`; and which capability an action maps to, which
//! is `an-intent-maps-to-the-actions-the-host-answers.rs`.

mod support;

use std::collections::{BTreeSet, HashMap};

use support::{NOW_MS, session};
use veyyon_desktop::{
	SessionIndex, project,
	project::{project_controls, session_row_controls},
};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ConnectionState, HostActionKind, PROTOCOL_VERSION, QueuePartition,
	RequestId, RequestRegistry, SessionId, Store, SurfaceId, action_to_capability,
};
use veyyon_desktop_surface::{Availability, ShellState, queue::card_row_answers};

const SESSIONS: [&str; 3] = ["p", "q", "r"];

/// Three listed sessions on a connected store whose session capabilities the
/// host has declared, with the rail's row ids minted by the projection that
/// draws them.
fn rail_of_three() -> (Store, SessionIndex, ShellState) {
	let mut store = Store::new();
	store.connection = ConnectionState::Connected {
		endpoint: "127.0.0.1:47000".to_string(),
		protocol: PROTOCOL_VERSION,
	};
	for id in SESSIONS {
		store.sessions.insert(session(id, QueuePartition::Live));
	}
	for capability in [
		Capability::Sessions,
		Capability::SessionDeletion,
		Capability::SessionTreeNavigation,
		Capability::Transcript,
	] {
		store
			.capabilities
			.set(capability, CapabilityStatus::Available);
	}
	store.persisted.shell.active_session = Some(SessionId::from("q"));

	let mut index = SessionIndex::new();
	let mut state = ShellState::default();
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	assert!(
		SESSIONS
			.iter()
			.all(|id| index.row_id(&SessionId::from(*id)).is_some()),
		"the projection mints a row id for every session it draws a row for"
	);
	(store, index, state)
}

/// The row id of one of the fixture's sessions.
fn row_of(index: &SessionIndex, id: &str) -> u64 {
	index
		.row_id(&SessionId::from(id))
		.expect("a listed session has a row id")
}

/// The action each of a row's controls would send, keyed by the control, taken
/// from the projection's own table so a control added there is mapped here.
fn actions_of(row: u64) -> HashMap<SurfaceId, HostActionKind> {
	session_row_controls(&SessionId::from(row.to_string()))
		.into_iter()
		.collect()
}

/// The capability every answer of a row's menu is gated by, read through the
/// projection's table rather than written down.
fn answer_capabilities(row: u64) -> Vec<(SurfaceId, Capability)> {
	let actions = actions_of(row);
	card_row_answers(row)
		.into_iter()
		.map(|answer| {
			let action = actions.get(&answer.surface).copied().unwrap_or_else(|| {
				panic!(
					"the row menu answer {} reads {:?}, which no control in session_row_controls \
					 projects: add it there so the answer is gated",
					answer.label, answer.surface
				)
			});
			(answer.surface, action_to_capability(action))
		})
		.collect()
}

#[test]
fn a_row_that_stopped_being_active_reads_the_gate_of_the_live_frame() {
	let (mut store, index, mut state) = rail_of_three();
	let p = row_of(&index, "p");
	let gated_by = answer_capabilities(p);
	assert!(
		gated_by
			.iter()
			.any(|(_, capability)| *capability == Capability::Sessions),
		"the fixture reaches the defect only if some answer is gated by Sessions: {gated_by:?}"
	);

	// P is the session in hand while a CreateSession request is in flight, so
	// every answer of P's menu that Sessions gates is pending.
	store.persisted.shell.active_session = Some(SessionId::from("p"));
	let mut registry = RequestRegistry::new();
	let request = RequestId(4001);
	registry.register(
		request,
		HostActionKind::CreateSession,
		SurfaceId::NewSessionButton,
		NOW_MS,
		30_000,
	);
	project_controls(&store, &registry, &index, &mut state);
	for (surface, capability) in &gated_by {
		let expected = if *capability == Capability::Sessions {
			Availability::Pending
		} else {
			Availability::Enabled
		};
		assert_eq!(
			state.controls.availability(surface),
			expected,
			"while a Sessions request is in flight, {surface:?} reads its own capability"
		);
	}

	// The host answers, and another session becomes the one in hand. P's menu
	// states what P's capabilities say now, not what it was told then.
	registry.complete(&request);
	store.persisted.shell.active_session = Some(SessionId::from("q"));
	project_controls(&store, &registry, &index, &mut state);
	for (surface, _) in &gated_by {
		assert_eq!(
			state.controls.availability(surface),
			Availability::Enabled,
			"{surface:?} keeps no pending mark from the frame P was active on"
		);
	}
}

#[test]
fn every_answer_every_row_offers_reads_a_gate_the_projection_owns() {
	let (store, index, mut state) = rail_of_three();
	let registry = RequestRegistry::new();
	project_controls(&store, &registry, &index, &mut state);

	let mut swept = 0_usize;
	for id in store.sessions.items.keys() {
		let row = index.row_id(id).expect("a listed session has a row id");
		for answer in card_row_answers(row) {
			let _ = state.controls.availability(&answer.surface);
			swept += 1;
		}
	}
	assert_eq!(
		swept,
		SESSIONS.len() * card_row_answers(1).len(),
		"every row the rail draws offers the whole answer table"
	);
	assert_eq!(
		state.controls.unprojected(),
		Vec::new(),
		"a menu answer reading an id the projection does not own reads at rest, which states \
		 something false"
	);
}

#[test]
fn a_refusal_reaches_every_row_the_rail_draws_not_only_the_one_in_hand() {
	let (mut store, index, mut state) = rail_of_three();
	store
		.capabilities
		.set(Capability::SessionDeletion, CapabilityStatus::Unavailable {
			reason: "deletion disabled".to_string(),
		});
	let registry = RequestRegistry::new();
	project_controls(&store, &registry, &index, &mut state);

	let mut refused = 0_usize;
	for id in SESSIONS {
		let row = row_of(&index, id);
		for (surface, capability) in answer_capabilities(row) {
			let availability = state.controls.availability(&surface);
			if capability == Capability::SessionDeletion {
				assert_eq!(
					availability,
					Availability::Unavailable { reason: "deletion disabled".to_string() },
					"row {row} states the host's refusal on {surface:?}"
				);
				refused += 1;
			} else {
				assert_eq!(
					availability,
					Availability::Enabled,
					"row {row} gates {surface:?} on its own capability, not the refused one"
				);
			}
		}
	}
	assert_eq!(
		refused,
		SESSIONS.len(),
		"each of the three rows carries exactly one deletion answer to refuse"
	);
}

#[test]
fn a_session_the_host_stopped_listing_takes_its_gates_with_it() {
	let (mut store, index, mut state) = rail_of_three();
	let dropped = SessionId::from("r");
	let row = row_of(&index, "r");
	store.persisted.shell.active_session = Some(dropped.clone());
	let registry = RequestRegistry::new();
	project_controls(&store, &registry, &index, &mut state);
	let owned: BTreeSet<SurfaceId> = session_row_controls(&SessionId::from(row.to_string()))
		.into_iter()
		.map(|(surface, _)| surface)
		.collect();
	assert!(
		owned
			.iter()
			.all(|surface| state.controls.availability(surface) == Availability::Enabled),
		"the row in hand is projected before it is dropped"
	);
	let projected: BTreeSet<SurfaceId> = state
		.controls
		.projected()
		.map(|(id, _)| id.clone())
		.collect();
	assert!(owned.is_subset(&projected), "the active row's controls are projected: {owned:?}");

	// The host stops listing R and another session takes its place.
	store.sessions.remove(&dropped);
	store.persisted.shell.active_session = Some(SessionId::from("q"));
	project_controls(&store, &registry, &index, &mut state);
	let projected: BTreeSet<SurfaceId> = state
		.controls
		.projected()
		.map(|(id, _)| id.clone())
		.collect();
	assert!(
		owned.is_disjoint(&projected),
		"a session the host stopped listing leaves no gate behind: {:?}",
		owned.intersection(&projected).collect::<Vec<_>>()
	);
}
