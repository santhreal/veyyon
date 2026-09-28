//! Where the operator was reading, kept across a switch and a relaunch.
//!
//! The position is the entry at the top of the view and the pixels the view
//! starts past that entry's top, addressed by the entry id the host reports,
//! so it survives earlier turns paging in ahead of it. A view at the live edge
//! holds no position and comes back at the live edge. A position whose entry
//! is not on the branch yet is held, unwritten, until the entry arrives; a
//! scroll the operator makes before then replaces it.

use gpui::{Context, ListOffset, px};
use veyyon_desktop_model::TranscriptAnchor;

use super::Transcript;

impl Transcript {
	/// Takes the position remembered for the session the list now shows and
	/// places it, or holds it until its entry arrives.
	pub(super) fn restore_position(&mut self, cx: &mut Context<Self>) {
		self.pending = self
			.session
			.as_ref()
			.and_then(|session| self.app.read(cx).read_position(session).cloned());
		self.place_position(cx);
	}

	/// Scrolls to the held position once the entry it names is on the branch.
	pub(super) fn place_position(&mut self, cx: &mut Context<Self>) {
		let (Some(anchor), Some(session)) = (&self.pending, &self.session) else {
			return;
		};
		let app = self.app.read(cx);
		let Some(item_ix) = (0..self.entries).find(|&ix| {
			app.entry_at(session, ix)
				.is_some_and(|entry| entry.id.0 == anchor.entry_id)
		}) else {
			return;
		};
		let offset_in_item = px(anchor.offset_px as f32);
		self.list.scroll_to(ListOffset { item_ix, offset_in_item });
		self.pending = None;
		self.at_end = false;
		cx.notify();
	}

	/// Records where a scroll left the view: the entry at its top, or no
	/// position at the live edge. A held position is replaced.
	pub(super) fn record_position(&mut self, at_end: bool, cx: &mut Context<Self>) {
		let Some(session) = self.session.clone() else {
			return;
		};
		self.pending = None;
		let top = self.list.logical_scroll_top();
		let anchor = if at_end {
			None
		} else {
			self
				.app
				.read(cx)
				.entry_at(&session, top.item_ix)
				.map(|entry| {
					let offset_px = f32::from(top.offset_in_item).max(0.0).round() as u32;
					TranscriptAnchor { entry_id: entry.id.0.clone(), offset_px }
				})
		};
		self
			.app
			.update(cx, |app, cx| app.set_read_position(session, anchor, cx));
	}
}
