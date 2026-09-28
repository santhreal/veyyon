//! Row motion (FLIP on the row origin). A line whose slot in the list changes
//! is drawn where it was and slides to its slot on the [`motion::LAYOUT`]
//! spring, so a thread that moves to the top and the lines under a block or
//! project that opens or closes slide rather than jump. A line that was not
//! listed before fades and rises in under [`motion::REVEAL`]. A new filter
//! relists without motion, and so does the first listing.
//!
//! A frame is requested only while a line moves, and under reduced motion
//! every line lands at once. The list is virtualized, so a line that leaves
//! the list is not drawn leaving.

use std::{
	collections::HashMap,
	hash::{BuildHasher, RandomState},
};

use gpui::{
	AnyElement, App, IntoElement, ParentElement, Pixels, Styled, Window, div,
	motion::{Animator, AnimatorRegistry, FrameInstant, MotionDriver},
};
use veyyon_desktop_ui::theme::{motion, size};

use super::listing::{Block, Item};
use crate::state::Project;

/// What a line is, independent of the slot it is listed at.
#[derive(Hash)]
enum LineKey<'a> {
	Block(Block),
	Project(&'a str),
	Session(&'a str),
	Older,
}

/// Where each line was listed and how far each moving line still is from
/// its slot.
#[derive(Default)]
pub(super) struct RowMotion {
	hasher:  RandomState,
	/// The slot of each line of the last listing, by key.
	slots:   HashMap<u64, usize>,
	/// The next listing's slots, kept for its capacity.
	next:    HashMap<u64, usize>,
	/// The filter of the last listing, hashed.
	query:   u64,
	/// Each moving line's distance from its slot, in rows.
	offsets: AnimatorRegistry<u64, FrameInstant>,
	/// Each entering line's reveal, 0 hidden to 1 shown.
	reveals: AnimatorRegistry<u64, FrameInstant>,
	driver:  MotionDriver,
}

impl RowMotion {
	/// Records the slots of `items`. A line whose slot changed since the last
	/// listing under the same `query` slides from where it was drawn, and a
	/// line not listed then reveals.
	pub(super) fn relist(&mut self, items: &[Item], projects: &[Project], query: &str, cx: &App) {
		self.next.clear();
		for (slot, item) in items.iter().enumerate() {
			if let Some(key) = line_key(item, projects) {
				self.next.insert(self.hasher.hash_one(key), slot);
			}
		}
		let query = self.hasher.hash_one(query);
		let policy = cx.motion_policy();
		if !self.slots.is_empty() && query == self.query && !policy.reduced() {
			let now = cx.frame_instant();
			for (&key, &slot) in &self.next {
				match self.slots.get(&key) {
					Some(&was) if was != slot => {
						let moved = rows(was) - rows(slot);
						match self.offsets.get_mut(&key) {
							Some(offset) => {
								let drawn = offset.update(now);
								offset.start(
									drawn.value + moved,
									drawn.velocity,
									0.0,
									motion::LAYOUT,
									policy,
									now,
								);
							},
							None => {
								self
									.offsets
									.animate(key, moved, 0.0, motion::LAYOUT, policy, now);
							},
						}
					},
					Some(_) => {},
					None => {
						self
							.reveals
							.animate(key, 0.0, 1.0, motion::REVEAL, policy, now);
					},
				}
			}
		}
		self.query = query;
		std::mem::swap(&mut self.slots, &mut self.next);
	}

	/// Advances every moving line to this frame and requests the next frame
	/// while one moves.
	pub(super) fn step(&mut self, window: &mut Window, cx: &App) {
		if self.is_still() {
			return;
		}
		let mut frame = self.driver.begin(cx);
		frame.track(&mut self.offsets);
		frame.track(&mut self.reveals);
		self.driver.end(frame, window);
		self.offsets.retain_active();
		self.reveals.retain_active();
	}

	/// `element`, the line `item`, drawn where its motion has it this frame.
	pub(super) fn place(
		&self,
		item: &Item,
		projects: &[Project],
		element: AnyElement,
	) -> AnyElement {
		if self.is_still() {
			return element;
		}
		let Some(key) = line_key(item, projects).map(|key| self.hasher.hash_one(key)) else {
			return element;
		};
		let offset = self.offsets.get(&key).map_or(0.0, Animator::value);
		let shown = self
			.reveals
			.get(&key)
			.map_or(1.0, |reveal| reveal.value().clamp(0.0, 1.0));
		if offset.abs() < f32::EPSILON && shown >= 1.0 {
			return element;
		}
		let top: Pixels = size::ROW * offset + motion::REVEAL_RISE * (1.0 - shown);
		// A list line is laid out as a root, which ignores its own inset, so
		// the offset goes on a child.
		div()
			.w_full()
			.child(
				div()
					.w_full()
					.relative()
					.top(top)
					.opacity(shown)
					.child(element),
			)
			.into_any_element()
	}

	fn is_still(&self) -> bool {
		self.offsets.is_empty() && self.reveals.is_empty()
	}
}

fn line_key<'a>(item: &Item, projects: &'a [Project]) -> Option<LineKey<'a>> {
	Some(match *item {
		Item::Block { block, .. } => LineKey::Block(block),
		Item::Project(project) => LineKey::Project(projects.get(project)?.path.as_str()),
		Item::Session { project, row, .. } => {
			LineKey::Session(projects.get(project)?.sessions.get(row)?.id.0.as_str())
		},
		Item::Older(_) => LineKey::Older,
	})
}

#[expect(clippy::cast_precision_loss, reason = "a list slot is far below 2^24")]
const fn rows(slot: usize) -> f32 {
	slot as f32
}
