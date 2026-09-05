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
mod cards;
mod composer;
mod connection;
mod controls;
mod drawer;
mod failure;
mod overlay;
mod panel;
mod queue;
mod transcript;
use std::collections::HashMap;

use veyyon_desktop_model::{QueuePartition, SessionId, Store};
use veyyon_desktop_surface::{Badge, ShellState, terminal::TerminalEmulator};

pub use self::{
	actions::actions_for,
	composer::{project_composer, project_turn_phase},
	connection::{connection_notice, connection_phase},
	controls::{NO_SESSION_OPEN, project_controls},
	drawer::{drawer_lines, project_drawer, strip_control_sequences},
	failure::land_failure,
	overlay::project_overlay,
	panel::{project_panel, tree_rows_from_changes},
	queue::elapsed_label,
	transcript::PANE_LINE_CEILING,
};
use self::{
	cards::cards,
	queue::{badge, partition_ids, row, section},
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

	state.sections = QueuePartition::ALL
		.iter()
		.filter_map(|partition| {
			let ids = partition_ids(store, *partition);
			if ids.is_empty() {
				return None;
			}
			let rows = ids
				.iter()
				.filter_map(|id| store.sessions.get(id))
				.map(|session| row(session, index.row_of(&session.id), now_ms))
				.collect();
			Some((section(*partition), rows))
		})
		.collect();

	let active_session = active.and_then(|id| store.sessions.get(id));
	state.current_id = active.map_or(0, |id| index.row_of(id));
	state.title = active_session.map_or_else(|| "veyyon".to_string(), |s| s.title.clone());

	state.transcript = active
		.and_then(|id| store.transcripts.get(id))
		.map(turns)
		.unwrap_or_default();

	let streaming = active.and_then(|id| store.streaming.get(id));
	if let Some(stream) = streaming {
		push_entry(&mut state.transcript, &stream.accumulating);
	}

	state.run_status = match streaming {
		Some(stream) => Some((
			Badge::Working,
			stream
				.tool
				.as_ref()
				.map_or_else(|| "Working".to_string(), |tool| format!("Working · {tool}")),
		)),
		None => active_session.and_then(|s| s.badge.as_ref()).map(|b| {
			let badge = badge(b);
			(badge, badge.label().to_string())
		}),
	};

	state.cards = active
		.and_then(|id| store.interactions.get(id))
		.map(cards)
		.unwrap_or_default();

	state.panel = project_panel(&store.domains, &state.panel);
	state.turn = project_turn_phase(store, active);
	project_composer(store, active, &mut state.composer);
	project_drawer(&store.domains, emulators, now_ms, &mut state.drawer);
	state.connection = connection_phase(store);
	project_overlay(store, state);
}
