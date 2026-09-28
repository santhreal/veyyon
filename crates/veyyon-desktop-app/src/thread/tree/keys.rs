//! The sheet's keys, read while no field of the sheet is written in: the
//! arrows, the page keys, Home and End move the keyboard between rows, Enter
//! goes to the row, Escape steps back, Ctrl-O and Ctrl-Shift-O cycle the
//! filter, Alt with a filter's letter picks it and Shift-L labels the row.

use gpui::{Context, KeyDownEvent, Modifiers, ScrollStrategy, Window};
use strum::IntoEnumIterator as _;
use veyyon_desktop_model::SessionTreeFilter;
use veyyon_desktop_ui::editor;

use super::{SessionTreeSheet, Step, steps::SUMMARY_CHOICES};

/// Where a key moves the keyboard among the shown rows.
#[derive(Clone, Copy)]
enum Move {
	Prev,
	Next,
	PageUp,
	PageDown,
	First,
	Last,
}

impl SessionTreeSheet {
	pub(super) fn on_key_down(
		&mut self,
		event: &KeyDownEvent,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if in_editor(window) {
			return;
		}
		let keystroke = &event.keystroke;
		let key = keystroke.key.as_str();
		let handled = if !keystroke.modifiers.modified() && key == "escape" {
			self.escape(window, cx);
			true
		} else {
			match self.step {
				Step::Browse => self.browse_key(key, keystroke.modifiers, window, cx),
				Step::Summary { .. } if !keystroke.modifiers.modified() => {
					self.summary_key(key, window, cx)
				},
				Step::Summary { .. } | Step::Instructions { .. } | Step::Label { .. } => false,
			}
		};
		if handled {
			cx.stop_propagation();
		}
	}

	/// A key pressed on the rows.
	fn browse_key(
		&mut self,
		key: &str,
		modifiers: Modifiers,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> bool {
		let Modifiers { control, alt, shift, platform, function, .. } = modifiers;
		match ((control, alt, shift, platform || function), key) {
			((true, false, shift, false), "o") => self.cycle_filter(!shift, cx),
			((false, true, false, false), key) => {
				let Some(filter) = filter_key(key) else {
					return false;
				};
				self.pick_filter(filter, cx);
			},
			((false, false, true, false), "l") => self.edit_label(window, cx),
			((false, false, false, false), "enter") => self.confirm(window, cx),
			((false, false, false, false), key) => {
				let to = match key {
					"up" => Move::Prev,
					"down" => Move::Next,
					"left" | "pageup" => Move::PageUp,
					"right" | "pagedown" => Move::PageDown,
					"home" => Move::First,
					"end" => Move::Last,
					_ => return false,
				};
				self.move_to(to, cx);
			},
			_ => return false,
		}
		true
	}

	/// A key pressed on the summary choices: the arrows move between them,
	/// wrapping, and Enter picks the one the keyboard is on.
	fn summary_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
		let Step::Summary { cursor, .. } = &mut self.step else {
			return false;
		};
		let count = SUMMARY_CHOICES.len();
		match key {
			"up" => *cursor = (*cursor + count - 1) % count,
			"down" => *cursor = (*cursor + 1) % count,
			"enter" => {
				let choice = *cursor;
				self.pick_summary(choice, window, cx);
				return true;
			},
			_ => return false,
		}
		cx.notify();
		true
	}

	/// Moves the keyboard among the shown rows: the arrows wrap, a page
	/// stops at either end.
	fn move_to(&mut self, to: Move, cx: &mut Context<Self>) {
		let count = self.shown.len();
		if count == 0 {
			return;
		}
		let at = self.selected_ix(cx).unwrap_or(0);
		let next = match to {
			Move::Prev => (at + count - 1) % count,
			Move::Next => (at + 1) % count,
			Move::PageUp => at.saturating_sub(self.page),
			Move::PageDown => (at + self.page).min(count - 1),
			Move::First => 0,
			Move::Last => count - 1,
		};
		self.select_ix(next, cx);
	}

	/// Puts the keyboard on shown row `ix` and scrolls it into view.
	pub(super) fn select_ix(&mut self, ix: usize, cx: &mut Context<Self>) {
		let Some(node) = self
			.shown
			.get(ix)
			.and_then(|node| self.tree(cx)?.nodes.get(*node))
		else {
			return;
		};
		self.selected = Some(node.id.clone());
		self.list.scroll_to_item(ix, ScrollStrategy::Nearest);
		cx.notify();
	}

	/// Shows the next filter in the terminal's order, or the previous one.
	fn cycle_filter(&mut self, forward: bool, cx: &mut Context<Self>) {
		let current = self.current_filter(cx);
		let next = if forward {
			following(SessionTreeFilter::iter(), current)
		} else {
			following(SessionTreeFilter::iter().rev(), current)
		};
		self.pick_filter(next, cx);
	}
}

/// The filter after `current` in `order`, wrapping.
fn following<I>(order: I, current: SessionTreeFilter) -> SessionTreeFilter
where
	I: Iterator<Item = SessionTreeFilter> + Clone,
{
	order
		.cycle()
		.skip_while(|filter| *filter != current)
		.nth(1)
		.unwrap_or(current)
}

/// The filter Alt with `key` picks, by the letter of its name.
fn filter_key(key: &str) -> Option<SessionTreeFilter> {
	Some(match key {
		"d" => SessionTreeFilter::Default,
		"t" => SessionTreeFilter::NoTools,
		"u" => SessionTreeFilter::UserOnly,
		"l" => SessionTreeFilter::LabeledOnly,
		"a" => SessionTreeFilter::All,
		_ => return None,
	})
}

/// Whether the keyboard is in a text field.
fn in_editor(window: &Window) -> bool {
	window
		.context_stack()
		.iter()
		.any(|context| context.contains(editor::KEY_CONTEXT))
}
