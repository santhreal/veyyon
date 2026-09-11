//! From what the host reported to what the surfaces draw.
//!
//! `Store` holds the protocol model: every session the host listed, the
//! transcript tree with its branches, the interactions waiting on an answer.
//! `ShellState` holds what one render shows: sections of rows, a linear run of
//! turns, a stack of cards. This module is the one place the first becomes the
//! second, and the one place an operator's intent becomes a `HostAction`.
//!
//! The projection overwrites only the fields the host owns. What the window
//! owns — the composer's text, the drawer, the panel's tab — is left as it is,
//! so a frame arriving mid-keystroke does not take the keystroke away.
//!
//! One file per region: the queue, the transcript, the cards, the panel and the
//! drawer each project their own fields, and `actions` turns an intent into the
//! host actions it asks for.

mod actions;
mod branch;
mod cards;
mod composer;
mod connection;
mod controls;
mod drawer;
mod failure;
mod notices;
mod overlay;
mod panel;
mod queue;
mod requests;
mod run_bar;
mod submission;
mod transcript;
mod workspace_asks;
use std::collections::HashMap;

use veyyon_desktop_model::{
	QueuePartition, SessionId, Store, session_badge, text::terminal::TerminalEmulator,
};
use veyyon_desktop_surface::{Row, Section, ShellState};

pub use self::{
	actions::actions_for,
	branch::{
		BranchPoint, branch_point, branch_point_at, branched_draft, land_branched_draft, record_fork,
	},
	composer::{project_composer, project_turn_phase, restored_draft},
	connection::{connection_notice, connection_phase, transport_gate, transport_gate_capability},
	controls::{
		ANSWERED_BY_OPTION, NO_SESSION_OPEN, contextual_surface_for_action, gated_controls,
		project_controls, session_row_controls,
	},
	drawer::{drawer_lines, project_drawer, resize_terminals, strip_control_sequences},
	failure::land_failure,
	notices::{expire_notices, project_notices},
	overlay::project_overlay,
	panel::project_panel,
	queue::{clear_sent_draft, elapsed_label},
	requests::{record_sent, surface_for_action},
	transcript::PANE_LINE_CEILING,
};
use self::{
	cards::cards,
	queue::{badge, holds_unsent_draft, partition_ids, row, row_meta, section, unsent_ids},
	run_bar::run_status,
	transcript::{push_entry, turns},
};

/// Row identities for sessions.
///
/// A queue row is keyed by a `u64` so a click survives the queue re-sorting
/// under it; a session is keyed by the host's string id. This maps between the
/// two, and a session keeps its row id for the life of the window, so a row
/// that moved from Live to Deferred is still the row that was selected.
#[derive(Debug, Default)]
pub struct SessionIndex {
	rows:     HashMap<SessionId, u64>,
	sessions: Vec<SessionId>,
}

impl SessionIndex {
	/// An empty index.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// The row id for a session, minted on first sight. Row ids start at one;
	/// zero is the id of no session.
	pub fn row_of(&mut self, session: &SessionId) -> u64 {
		if let Some(row) = self.rows.get(session) {
			return *row;
		}
		self.sessions.push(session.clone());
		let row = self.sessions.len() as u64;
		self.rows.insert(session.clone(), row);
		row
	}

	/// The row id already minted for a session, if any.
	#[must_use]
	pub fn row_id(&self, session: &SessionId) -> Option<u64> {
		self.rows.get(session).copied()
	}

	/// The session a row id stands for, if one was minted for it.
	#[must_use]
	pub fn session_of(&self, row: u64) -> Option<&SessionId> {
		let index = usize::try_from(row.checked_sub(1)?).ok()?;
		self.sessions.get(index)
	}
}

/// The setting that states whether the operator wants structural motion.
pub const TRANSITIONS_SETTING: &str = "display.transitions";

/// Whether the operator has turned structural motion off (§7.2).
///
/// The schema declares `on` and `off` and defaults to `on`, so `off` is the
/// one value that means reduced: a host reporting anything else leaves the
/// window moving rather than reading a third meaning into a value it does
/// not know.
#[must_use]
pub fn reduced_motion(store: &Store) -> bool {
	store
		.domains
		.settings
		.as_ref()
		.and_then(|settings| settings.get(TRANSITIONS_SETTING))
		.and_then(|entry| entry.value.as_str())
		== Some("off")
}

/// Projects the store onto the shell state's host-owned fields.
///
/// `emulators` are the terminals the window feeds as chunks arrive; a
/// terminal without one is replayed from the store's scrollback. `now_ms` is
/// the clock the elapsed labels are measured against; it is passed in so a
/// test can pin it.
pub fn project<S: std::hash::BuildHasher>(
	store: &Store,
	index: &mut SessionIndex,
	emulators: &HashMap<String, TerminalEmulator, S>,
	now_ms: u64,
	state: &mut ShellState,
) {
	let active = store.persisted.shell.active_session.as_ref();

	// §0 orders the rail `Unsent`, `Pinned`, `Live`, `Deferred`, `Parked`, and
	// `Unsent` is the one section no placement produces: it is every session
	// holding a draft the operator left, so it is built first and its rows are
	// taken out of the partitions they are placed in.
	let unsent_rows: Vec<Row> = unsent_ids(store, active)
		.iter()
		.filter_map(|id| store.sessions.get(id))
		.map(|session| row(store, session, index.row_of(&session.id), now_ms))
		.collect();

	state.sections = (!unsent_rows.is_empty())
		.then_some((Section::Unsent, unsent_rows))
		.into_iter()
		.chain(QueuePartition::ALL.iter().filter_map(|partition| {
			let rows: Vec<Row> = partition_ids(store, *partition)
				.iter()
				.filter(|id| !holds_unsent_draft(store, active, id))
				.filter_map(|id| store.sessions.get(id))
				.map(|session| row(store, session, index.row_of(&session.id), now_ms))
				.collect();
			(!rows.is_empty()).then(|| (section(*partition), rows))
		}))
		.collect();

	let active_session = active.and_then(|id| store.sessions.get(id));
	state.current_id = active.map_or(0, |id| index.row_of(id));
	state.title = active_session.map_or_else(|| "veyyon".to_string(), |s| s.title.clone());

	let mut projected = active
		.and_then(|id| store.transcripts.get(id))
		.map(turns)
		.unwrap_or_default();

	let streaming = active.and_then(|id| store.streaming.get(id));
	if let Some(stream) = streaming {
		push_entry(&mut projected, &stream.accumulating);
	}
	state.transcript = projected.turns;
	state.turn_anchors = projected.anchors;

	state.run_status = active
		.and_then(|id| session_badge(store, id, now_ms))
		.and_then(|derived| run_status(store, active, Some(&derived)));

	state.cards = active
		.and_then(|id| store.interactions.get(id))
		.map(cards)
		.unwrap_or_default();

	// The panel is handed what the window already has, by value: what it can
	// hold rather than derive again is moved out of it.
	state.panel =
		project_panel(&store.domains, &store.capabilities, active, std::mem::take(&mut state.panel));
	state.turn = project_turn_phase(store, active, state.composer.queue_mode);
	project_composer(store, active, &mut state.composer);
	project_drawer(&store.domains, &store.capabilities, emulators, now_ms, &mut state.drawer);
	// §5.13: a drawer the host no longer offers leaves the surface rather than
	// standing open on an empty grid.
	state.drawer_open = state.drawer_open && state.drawer.offered;
	state.connection = connection_phase(store);
	project_overlay(store, state);
	state.reduced_motion = reduced_motion(store);
	project_notices(store, now_ms, state);
}

/// Updates elapsed and remaining time labels across queue rows and drawer
/// processes without a full transcript or composer reprojection.
///
/// Returns `true` if any visible time label changed, allowing the shell to
/// repaint only when the elapsed seconds tick over.
pub fn project_clock(
	store: &Store,
	index: &SessionIndex,
	now_ms: u64,
	state: &mut ShellState,
) -> bool {
	let mut changed = false;
	for (_section, rows) in &mut state.sections {
		for row in rows {
			if let Some(session_id) = index.session_of(row.id)
				&& let Some(session) = store.sessions.get(session_id)
			{
				// A deferral elapsing is the one badge change no host event
				// reports: the return time passes while nothing arrives, so
				// the tick that moves the label resolves the badge again.
				let derived = session_badge(store, session_id, now_ms);
				let new_badge = derived.as_ref().map(badge);
				let new_meta = Some(row_meta(session, derived.as_ref(), now_ms));
				if row.badge != new_badge {
					row.badge = new_badge;
					changed = true;
				}
				if row.meta != new_meta {
					row.meta = new_meta;
					changed = true;
				}
			}
		}
	}
	for process in &mut state.drawer.processes {
		if let Some(p) = store
			.domains
			.processes
			.iter()
			.find(|d| d.name == process.name && d.pid == process.pid)
		{
			let new_elapsed = elapsed_label(now_ms.saturating_sub(p.started_at_ms));
			if process.elapsed_label != new_elapsed {
				process.elapsed_label = new_elapsed;
				changed = true;
			}
		}
	}
	changed
}
