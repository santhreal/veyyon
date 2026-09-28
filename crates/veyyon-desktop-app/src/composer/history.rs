//! Up and Down step through the prompts sent before.
//!
//! The list is the prompts this composer sent, newest first, then the ones
//! the host's prompt history holds. Up on an empty draft starts at the newest
//! and stashes the draft; Down past the newest puts the stash back. Typing
//! ends the recall where it stands. The host's history is asked for the first
//! time Up runs out of prompts this composer sent.

use gpui::{Context, Window};
use veyyon_desktop_model::{HostAction, SurfaceId};

use super::Composer;
use crate::AppState;

/// Most prompts the composer remembers sending.
const REMEMBERED: usize = 100;

/// Where Up and Down stand in the prompts sent before.
#[derive(Default)]
pub(super) struct Recall {
	/// Prompts this composer sent, oldest first.
	sent:   Vec<String>,
	/// The shown prompt, counted from the newest; `None` while not recalling.
	at:     Option<usize>,
	/// The draft Up replaced.
	stash:  String,
	/// Up ran out of prompts and asked the host for its history.
	wanted: bool,
}

impl Recall {
	/// Records a prompt the composer sent.
	pub(super) fn remember(&mut self, text: &str) {
		let text = text.trim();
		if text.is_empty() || self.sent.last().is_some_and(|last| last == text) {
			return;
		}
		if self.sent.len() == REMEMBERED {
			self.sent.remove(0);
		}
		self.sent.push(text.to_owned());
	}

	/// Ends the recall, keeping the draft as it is.
	pub(super) const fn forget(&mut self) {
		self.at = None;
		self.wanted = false;
	}

	/// The recallable prompts, newest first, each once.
	fn prompts(&self, app: &AppState) -> Vec<String> {
		let mut prompts: Vec<String> = self.sent.iter().rev().cloned().collect();
		let host = app.store().domains.prompt_history.as_ref();
		let entries = host
			.filter(|view| view.query.is_empty())
			.map(|view| view.entries.as_slice());
		for entry in entries.unwrap_or_default() {
			let prompt = entry.prompt.trim();
			if !prompt.is_empty() && !prompts.iter().any(|held| held == prompt) {
				prompts.push(prompt.to_owned());
			}
		}
		prompts
	}
}

impl Composer {
	/// Up with the caret on the first row: the prompt before the shown one.
	pub(super) fn recall_prev(&mut self, cx: &mut Context<Self>) {
		let Some(session) = self.session.clone() else {
			return;
		};
		if self.recall.at.is_none() && !self.text(cx).is_empty() {
			return;
		}
		let prompts = self.recall.prompts(self.app.read(cx));
		let next = self.recall.at.map_or(0, |at| at + 1);
		if let Some(prompt) = prompts.get(next) {
			if self.recall.at.is_none() {
				self.recall.stash = self.text(cx).to_owned();
			}
			self.recall.at = Some(next);
			self.recall.wanted = false;
			let prompt = prompt.clone();
			self.set_text(&prompt, cx);
			return;
		}
		let asked = self
			.app
			.read(cx)
			.store()
			.domains
			.prompt_history
			.as_ref()
			.is_some_and(|view| view.query.is_empty());
		if !asked && !self.recall.wanted {
			self.recall.wanted = true;
			let action = HostAction::SearchPromptHistory { query: String::new() };
			self.app.update(cx, |app, cx| {
				app.dispatch(action, SurfaceId::ComposerHistoryButton(session), cx);
			});
		}
	}

	/// Down with the caret on the last row: the prompt after the shown one,
	/// or the stashed draft past the newest.
	pub(super) fn recall_next(&mut self, cx: &mut Context<Self>) {
		let Some(at) = self.recall.at else {
			return;
		};
		if at == 0 {
			self.recall.at = None;
			let stash = std::mem::take(&mut self.recall.stash);
			self.set_text(&stash, cx);
			return;
		}
		let prompts = self.recall.prompts(self.app.read(cx));
		self.recall.at = Some(at - 1);
		if let Some(prompt) = prompts.get(at - 1) {
			let prompt = prompt.clone();
			self.set_text(&prompt, cx);
		}
	}

	/// The host's prompt history arrived: the recall that asked for it steps
	/// on, and an open history menu lists it.
	pub(super) fn history_arrived(&mut self, cx: &mut Context<Self>) {
		self.history_changed(cx);
		if self.recall.wanted {
			self.recall.wanted = false;
			self.recall_prev(cx);
		}
	}

	/// `composer::SearchHistory`: asks the host for the prompts matching the
	/// draft and opens the history menu on them.
	pub(super) fn search_history(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let Some(session) = self.session.clone() else {
			return;
		};
		let query = self.text(cx).trim().to_owned();
		self.app.update(cx, |app, cx| {
			app.dispatch(
				HostAction::SearchPromptHistory { query },
				SurfaceId::ComposerHistoryButton(session),
				cx,
			);
		});
		self.open_history(window, cx);
	}
}
