//! The tail's list slot: given while the tail draws anything, moved by the
//! entries' splices, and taken in place by the reply's committed entry.

use std::ops::Range;

use gpui::{App, Context, ListOffset};
use veyyon_desktop_model::{ContentBlock, MessageRole};

use super::Transcript;

/// The list slot after the entries, where the streaming tail draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Slot {
	/// No slot: nothing streams and nothing is held.
	Absent,
	/// A reply or a tool is streaming.
	Streaming,
	/// The stream ended and the tail holds its prose until the committed
	/// entry arrives and takes the slot.
	Ending,
}

impl Transcript {
	/// Applies a store splice of the entries. The tail slot sits after them
	/// and moves with the splice; a held tail's slot is taken in place by the
	/// first entry that lands after the last one.
	pub(super) fn splice(&mut self, range: &Range<usize>, count: usize, cx: &mut Context<Self>) {
		let Some(session) = self.session.clone() else {
			return;
		};
		if self.slot == Slot::Ending && range.end == self.entries && count > range.len() {
			self.list.splice(range.clone(), count - 1);
			let slot = range.start + count - 1;
			self.list.remeasure_items(slot..slot + 1);
			self.slot = Slot::Absent;
			self.tail.update(cx, |tail, cx| tail.release(cx));
		} else {
			self.list.splice(range.clone(), count);
		}
		self.entries = self.entries.saturating_sub(range.len()) + count;
		let app = self.app.read(cx);
		let touched = self.turns.splice(app, &session, range);
		let spliced = range.start..range.start + count;
		if touched.start < spliced.start {
			self.list.remeasure_items(touched.start..spliced.start);
		}
		if spliced.end < touched.end {
			self.list.remeasure_items(spliced.end..touched.end);
		}
		cx.notify();
		self.place_position(cx);
	}

	/// Brings the tail up to the stream and gives it a slot while it draws
	/// anything. A delta remeasures the slot and lays the list out again: a
	/// tail below the view is not painted, so its own notify reaches no
	/// ancestor, and the list would clamp a scroll to the height it had.
	pub(super) fn sync_tail(&mut self, cx: &mut Context<Self>) {
		let session = self.session.clone();
		self
			.tail
			.update(cx, |tail, cx| tail.sync(session.as_ref(), cx));
		let streaming = session
			.as_ref()
			.is_some_and(|session| self.app.read(cx).streaming(session).is_some());
		let empty = self.tail.read(cx).is_empty();
		let (n, next) = (
			self.entries,
			if streaming {
				Slot::Streaming
			} else {
				Slot::Ending
			},
		);
		if !streaming
			&& !empty
			&& self.slot != Slot::Absent
			&& self.last_entry_reads(self.tail.read(cx).text(), cx)
		{
			// The reply's entry landed before its stream ended and already
			// draws it: the slot goes, and a reader inside the reply moves onto
			// the entry at the same offset.
			let top = self.list.logical_scroll_top();
			self.tail.update(cx, |tail, cx| tail.release(cx));
			self.list.splice(n..n + 1, 0);
			self.slot = Slot::Absent;
			if top.item_ix == n && n > 0 {
				self
					.list
					.scroll_to(ListOffset { item_ix: n - 1, offset_in_item: top.offset_in_item });
			}
			cx.notify();
			return;
		}
		match (self.slot, empty) {
			(Slot::Absent, true) => {},
			(Slot::Absent, false) => {
				self.list.splice(n..n, 1);
				self.slot = next;
				cx.notify();
			},
			(Slot::Streaming | Slot::Ending, true) => {
				self.list.splice(n..n + 1, 0);
				self.slot = Slot::Absent;
				cx.notify();
			},
			(Slot::Streaming | Slot::Ending, false) => {
				self.list.remeasure_items(n..n + 1);
				self.slot = next;
				cx.notify();
			},
		}
	}

	/// Whether the last entry the list draws is an agent reply whose prose is
	/// `text`.
	fn last_entry_reads(&self, text: &str, cx: &App) -> bool {
		let (Some(session), Some(last)) = (&self.session, self.entries.checked_sub(1)) else {
			return false;
		};
		self
			.app
			.read(cx)
			.entry_at(session, last)
			.is_some_and(|entry| {
				let mut rest = text;
				for block in &entry.content {
					if let ContentBlock::Text { text: part } = block {
						match rest.strip_prefix(part.as_str()) {
							Some(after) => rest = after,
							None => return false,
						}
					}
				}
				entry.role == MessageRole::Assistant && rest.is_empty()
			})
	}
}
