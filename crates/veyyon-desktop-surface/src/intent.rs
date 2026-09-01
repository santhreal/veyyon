//! What the operator asked the shell to do.
//!
//! An intent is separated from its effect because the two have different
//! owners. Some of what an intent changes belongs to the window alone: which
//! row is drawn as open, which tab the panel shows, whether the drawer is
//! docked. The rest belongs to a host: approving a tool call, answering a
//! question, sending a message, and streaming the session that was just
//! opened.
//!
//! So an intent is applied locally for the part the shell owns, and is also
//! recorded when something outside the window has to answer it. A surface never
//! talks to a host directly, which is what keeps every surface renderable with
//! no host attached.

use crate::model::ShellState;

/// One thing the operator did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Intent {
	/// Open a session from the queue.
	SelectSession(u64),
	/// Show a different tab in the right panel.
	SelectTab(usize),
	/// Open or close the terminal drawer.
	ToggleDrawer,
	/// Answer the approval attached at this position with a decision.
	Approval {
		/// The card's position in the stack.
		card:     usize,
		/// Whether the operator approved it.
		approved: bool,
	},
	/// Answer the question attached at this position.
	Answer {
		/// The card's position in the stack.
		card:   usize,
		/// The chosen option's position.
		option: usize,
	},
	/// Accept or revise the plan attached at this position.
	Plan {
		/// The card's position in the stack.
		card:     usize,
		/// Whether the operator accepted it.
		accepted: bool,
	},
	/// Send what the composer holds.
	Send(String),
}

impl Intent {
	/// Whether the shell can finish this intent alone.
	///
	/// A local intent is complete once the state changes: nothing outside the
	/// window is waiting on it, so reporting it to a host would be noise. The
	/// rest are requests a host answers, and the shell's own change is only the
	/// optimistic part — removing an answered card, clearing what was sent.
	///
	/// Opening a session is not local. The highlight is, but the transcript
	/// belongs to the host, and a shell that kept the selection to itself would
	/// draw a row as open that nothing ever filled.
	pub const fn is_local(&self) -> bool {
		matches!(self, Self::SelectTab(_) | Self::ToggleDrawer)
	}

	/// Applies the part of this intent the shell owns.
	///
	/// Every out-of-range position is dropped rather than clamped. A tab index
	/// or a card position that no longer exists means the state moved under the
	/// click, and the nearest surviving one is not what was clicked.
	pub fn apply(&self, state: &mut ShellState) {
		match *self {
			Self::SelectSession(id) => {
				state.current_id = id;
				// The titlebar names the open session, so a selection that did
				// not move the title has left the chrome describing the
				// previous one.
				if let Some(title) = state.row(id).map(|row| row.title.clone()) {
					state.title = title;
				}
			},
			Self::SelectTab(index) => {
				if index < state.tabs.len() {
					state.active_tab = index;
				}
			},
			Self::ToggleDrawer => state.drawer_open = !state.drawer_open,
			// A card is removed as soon as it is answered, because a decision
			// surface that keeps offering an answered question invites the
			// operator to answer it twice.
			Self::Approval { card, .. } | Self::Answer { card, .. } | Self::Plan { card, .. } => {
				if state.cards.get(card).is_some() {
					state.cards.remove(card);
				}
			},
			Self::Send(_) => state.composed.clear(),
		}
	}
}

/// The intents recorded for a host, and the one place an intent is applied.
///
/// Kept apart from the view because a click's effect is a function of an intent
/// and a state: nothing about it needs a window, a renderer or a gpui context.
/// Holding it here is what makes the whole interaction contract exercisable
/// without rendering a frame.
#[derive(Debug, Default)]
pub struct Intents {
	pending: Vec<Intent>,
}

impl Intents {
	/// An empty record.
	pub const fn new() -> Self {
		Self { pending: Vec::new() }
	}

	/// Applies what the operator did, and records what a host must answer.
	///
	/// Every surface reaches the state through here and through nothing else,
	/// so what an interaction does is decided in one place rather than once per
	/// click handler.
	pub fn dispatch(&mut self, intent: Intent, state: &mut ShellState) {
		// An empty send is discarded rather than recorded. A host that received
		// it would have to decide what an empty message means, and there is no
		// answer to that better than not sending it.
		if let Intent::Send(text) = &intent
			&& text.trim().is_empty()
		{
			return;
		}

		intent.apply(state);
		if !intent.is_local() {
			self.pending.push(intent);
		}
	}

	/// Takes the intents a host has not seen yet.
	///
	/// A transport drains this. The shell holds no connection, so an intent
	/// nothing drains accumulates rather than failing.
	pub fn drain(&mut self) -> Vec<Intent> {
		std::mem::take(&mut self.pending)
	}

	/// The intents recorded and not yet drained, in the order they happened.
	pub fn pending(&self) -> &[Intent] {
		&self.pending
	}
}
