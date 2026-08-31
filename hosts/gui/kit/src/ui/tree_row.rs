//! Indented tree row.
//!
//! This wrapper keeps tree depth and disclosure semantics explicit while using
//! the same stable metadata and hover-action geometry as [`Row`](super::Row).

use gpui::{App, ClickEvent, IntoElement, RenderOnce, SharedString, Window};

use super::{Icon, Row, Tone};
use crate::motion::RetainedKey;

#[derive(IntoElement)]
pub struct TreeRow {
	row: Row,
}
impl TreeRow {
	pub fn new(
		id: impl Into<SharedString>,
		owner: RetainedKey,
		title: impl Into<SharedString>,
		depth: u8,
	) -> Self {
		Self { row: Row::new(id, owner, title).depth(depth).gutter(true) }
	}

	pub fn icon(mut self, icon: Icon) -> Self {
		self.row = self.row.icon(icon);
		self
	}

	pub fn note(mut self, note: impl Into<SharedString>) -> Self {
		self.row = self.row.note(note);
		self
	}

	pub fn tone(mut self, tone: Tone) -> Self {
		self.row = self.row.tone(tone);
		self
	}

	pub fn selected(mut self, selected: bool) -> Self {
		self.row = self.row.selected(selected);
		self
	}

	pub fn active(mut self, active: bool) -> Self {
		self.row = self.row.active(active);
		self
	}

	pub fn disabled(mut self, reason: impl Into<SharedString>) -> Self {
		self.row = self.row.disabled(reason);
		self
	}

	pub fn on_click(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.row = self.row.on_click(listener);
		self
	}
}
impl RenderOnce for TreeRow {
	fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
		self.row
	}
}
