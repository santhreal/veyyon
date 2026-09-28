//! Inline completion above the draft: the commands the host lists for a `/`
//! at the start of the draft, the workspace files the host finds for an `@`
//! before the caret, and what the session's extensions offer for the draft.
//!
//! Up and Down move the highlight while the list shows, Enter and Tab accept
//! the highlighted row, and Escape closes the list until the draft changes.

use std::ops::Range;

use gpui::{AnyElement, App, Context, SharedString, div, prelude::*};
use veyyon_desktop_model::{ComposerRequest, Gate, HostAction, HostActionKind, SurfaceId};
use veyyon_desktop_ui::{
	controls::ListRow,
	theme::{ActiveTheme, TypeStyled, radius, space, text},
};

use super::Composer;

/// Most rows the list shows; typing narrows it.
const ROWS: usize = 8;

/// What the token at the caret asks to complete.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Trigger {
	/// `/name` as the first word of the draft.
	Command { range: Range<usize>, query: String },
	/// `@path` around the caret.
	File { range: Range<usize>, query: String },
}

/// One row of the list and the edit accepting it makes.
pub(super) struct Item {
	label:   SharedString,
	detail:  Option<SharedString>,
	replace: Range<usize>,
	insert:  String,
	/// Where the caret lands, as an offset into the draft after the edit;
	/// `None` leaves it after the inserted text.
	caret:   Option<usize>,
}

/// The open completion list.
#[derive(Default)]
pub(super) struct Completion {
	trigger:   Option<Trigger>,
	highlight: usize,
}

/// The trigger the word around `caret` in `text` makes, if any.
fn trigger(text: &str, caret: usize) -> Option<Trigger> {
	let before = text.get(..caret)?;
	let start = before
		.char_indices()
		.rev()
		.find(|(_, ch)| ch.is_whitespace())
		.map_or(0, |(ix, ch)| ix + ch.len_utf8());
	let end = text[caret..]
		.find(char::is_whitespace)
		.map_or(text.len(), |ix| caret + ix);
	let token = &before[start..];
	if start == 0
		&& let Some(query) = token.strip_prefix('/')
	{
		return Some(Trigger::Command { range: 0..end, query: query.to_owned() });
	}
	token
		.strip_prefix('@')
		.map(|query| Trigger::File { range: start..end, query: query.to_owned() })
}

impl Composer {
	/// The rows the list shows for the draft as it stands.
	pub(super) fn completion_items(&self, cx: &App) -> Vec<Item> {
		let Some(completion) = &self.completion else {
			return Vec::new();
		};
		let store = self.app.read(cx).store();
		let mut items = Vec::new();
		match &completion.trigger {
			Some(Trigger::Command { range, query }) => {
				let query = query.to_lowercase();
				let matches = |name: &str| name.to_lowercase().starts_with(&query);
				for command in store.domains.commands.iter().filter(|command| {
					matches(&command.name) || command.aliases.iter().any(|alias| matches(alias))
				}) {
					items.push(Item {
						label:   format!("/{}", command.name).into(),
						detail:  command.description.clone().map(Into::into),
						replace: range.clone(),
						insert:  format!("/{} ", command.name),
						caret:   None,
					});
				}
			},
			Some(Trigger::File { range, query }) => {
				let found = store
					.domains
					.search
					.as_ref()
					.filter(|view| &view.query == query);
				for path in found.map(|view| view.paths.as_slice()).unwrap_or_default() {
					items.push(Item {
						label:   path.clone().into(),
						detail:  None,
						replace: range.clone(),
						insert:  format!("@{path} "),
						caret:   None,
					});
				}
			},
			None => {},
		}
		let offered = self
			.session
			.as_ref()
			.and_then(|session| store.domains.completions.get(session));
		let len = self.text(cx).len();
		for item in offered
			.filter(|view| view.query == self.bridge.query)
			.into_iter()
			.flat_map(|view| &view.items)
		{
			let replace = item.replace_start as usize..item.replace_end as usize;
			if replace.start > replace.end || replace.end > len {
				continue;
			}
			items.push(Item {
				label: item.label.clone().into(),
				detail: item.description.clone().map(Into::into),
				replace,
				insert: item.insert.clone(),
				caret: Some(item.caret as usize),
			});
		}
		items.truncate(ROWS);
		items
	}

	/// The draft or caret moved: finds what the word at the caret completes,
	/// asks the host for the rows it needs and asks the extensions for theirs.
	pub(super) fn update_completion(&mut self, cx: &mut Context<Self>) {
		let Some(session) = self.session.clone() else {
			return;
		};
		let (found, text, cursor) = {
			let editor = self.editor.read(cx);
			(trigger(editor.text(), editor.cursor_offset()), editor.text(), editor.cursor_offset())
		};
		let app = self.app.read(cx);
		let completes = app
			.store()
			.domains
			.extension_ui
			.get(&session)
			.is_some_and(|ui| ui.completes)
			&& !matches!(app.gate(HostActionKind::CompleteComposer), Gate::Unavailable { .. });
		let mut actions = Vec::new();
		if completes {
			self.bridge.query += 1;
			let request = ComposerRequest::CompleteComposer {
				session: session.clone(),
				query:   self.bridge.query,
				text:    text.to_owned(),
				cursor:  u32::try_from(cursor).unwrap_or(u32::MAX),
			};
			actions.push(HostAction::Composer(request));
		}
		let previous = self
			.completion
			.as_ref()
			.and_then(|completion| completion.trigger.as_ref());
		if previous != found.as_ref() {
			match &found {
				Some(Trigger::File { query, .. }) => {
					actions.push(HostAction::SearchFiles { query: query.clone() });
				},
				Some(Trigger::Command { .. })
					if app.store().domains.commands.is_empty() && !self.bridge.listed =>
				{
					self.bridge.listed = true;
					actions.push(HostAction::ListCommands);
				},
				Some(Trigger::Command { .. }) | None => {},
			}
		}
		let changed =
			previous != found.as_ref() || self.completion.is_some() != (found.is_some() || completes);
		self.completion =
			(found.is_some() || completes).then_some(Completion { trigger: found, highlight: 0 });
		if !actions.is_empty() {
			let surface = SurfaceId::ComposerCompletionQuery(session);
			self.app.update(cx, |app, cx| {
				for action in actions {
					app.dispatch(action, surface.clone(), cx);
				}
			});
		}
		if changed {
			cx.notify();
		}
	}

	/// Keeps the highlight on a row after the rows changed.
	pub(super) fn clamp_highlight(&mut self, cx: &App) {
		let count = self.completion_items(cx).len();
		if let Some(completion) = &mut self.completion {
			completion.highlight = completion.highlight.min(count.saturating_sub(1));
		}
	}

	/// Closes the list until the draft changes.
	pub(super) fn close_completion(&mut self, cx: &mut Context<Self>) -> bool {
		let open = !self.completion_items(cx).is_empty();
		if self.completion.take().is_some() {
			cx.notify();
		}
		open
	}

	/// Moves the highlight one row, wrapping; `false` when no list shows.
	pub(super) fn move_highlight(&mut self, forward: bool, cx: &mut Context<Self>) -> bool {
		let count = self.completion_items(cx).len();
		let Some(completion) = self.completion.as_mut().filter(|_| count > 0) else {
			return false;
		};
		completion.highlight = if forward {
			(completion.highlight + 1) % count
		} else {
			completion.highlight.checked_sub(1).unwrap_or(count - 1)
		};
		cx.notify();
		true
	}

	/// Accepts row `ix`, or the highlighted row; `false` when no list shows.
	pub(super) fn accept_completion(&mut self, ix: Option<usize>, cx: &mut Context<Self>) -> bool {
		let Some(highlight) = self
			.completion
			.as_ref()
			.map(|completion| completion.highlight)
		else {
			return false;
		};
		let Some(item) = self
			.completion_items(cx)
			.into_iter()
			.nth(ix.unwrap_or(highlight))
		else {
			return false;
		};
		self.completion = None;
		self.editor.update(cx, |editor, cx| {
			editor.replace_range(item.replace, &item.insert, cx);
			if let Some(caret) = item.caret {
				editor.set_cursor_offset(caret, cx);
			}
		});
		cx.notify();
		true
	}

	/// The list above the composer frame, while it has rows.
	pub(super) fn render_completion(&self, cx: &Context<Self>) -> Option<AnyElement> {
		let items = self.completion_items(cx);
		let highlight = self.completion.as_ref()?.highlight;
		if items.is_empty() {
			return None;
		}
		let palette = cx.theme().palette;
		let rows = items.into_iter().enumerate().map(|(ix, item)| {
			let detail = item.detail.map(|detail| {
				div()
					.truncate()
					.type_style(text::SMALL)
					.text_color(palette.text.muted)
					.child(detail)
			});
			let mut row =
				ListRow::new(("composer-completion", ix), item.label).selected(ix == highlight);
			if let Some(detail) = detail {
				row = row.trailing(detail);
			}
			row.on_click(cx.listener(move |this, _, _, cx| {
				this.accept_completion(Some(ix), cx);
			}))
		});
		Some(
			div()
				.id("composer-completion")
				.flex()
				.flex_col()
				.p(space::S1)
				.bg(palette.bg.elevated)
				.border_1()
				.border_color(palette.border.default)
				.rounded(radius::LG)
				.shadow_md()
				.children(rows)
				.into_any_element(),
		)
	}
}
