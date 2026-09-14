//! Local intent application and pending host dispatch.

use super::{Intent, Intents, apply};
use crate::{model::ShellState, palette::PaletteState};

impl Intents {
	/// An empty record.
	pub const fn new() -> Self {
		Self { pending: Vec::new() }
	}

	/// Applies what the operator did, and records what a host must answer.
	///
	/// Running a palette command is the command: the palette closes and the
	/// command is dispatched as if its own control had been clicked, so one
	/// that needs a host reaches the host.
	pub fn dispatch(&mut self, intent: Intent, state: &mut ShellState) {
		if match &intent {
			Intent::Send { text, .. } | Intent::Steer(text) | Intent::Queue(text) => {
				text.trim().is_empty()
			},
			_ => false,
		} {
			return;
		}
		if let Intent::MoveQueueSelection(delta) = intent {
			if let Some(row) = apply::selection_target(state, delta) {
				self.dispatch(Intent::SelectSession(row), state);
			}
			return;
		}

		if intent == Intent::PaletteRun
			&& let Some(run) = state.overlay_palette().and_then(PaletteState::run_intent)
		{
			state.overlay = None;
			self.dispatch(run, state);
			return;
		}

		if intent == Intent::CloseTabOrPark && state.panel.tabs.len() <= 1 {
			self.dispatch(Intent::ParkSession(state.current_id), state);
			return;
		}

		intent.apply(state);
		if !intent.is_local() {
			self.pending.push(intent);
		}
	}

	/// Takes the intents a host has not seen yet.
	pub fn drain(&mut self) -> Vec<Intent> {
		std::mem::take(&mut self.pending)
	}

	/// The intents recorded and not yet drained, in the order they happened.
	pub fn pending(&self) -> &[Intent] {
		&self.pending
	}
}
