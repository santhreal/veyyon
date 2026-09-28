//! Entry reveal. An entry that lands while the thread is open fades in while
//! rising [`motion::REVEAL_RISE`] under [`motion::REVEAL`]. An entry drawn
//! because the thread opened, because the transcript was sent whole or
//! because it scrolled into view is drawn at rest, and so is an agent reply
//! that takes the place of prose the streaming tail already drew.
//!
//! A frame is requested only while an entry moves, and under reduced motion
//! every entry lands at once.

use std::{
	collections::HashSet,
	hash::{BuildHasher, RandomState},
};

use gpui::{
	AnyElement, App, IntoElement, ParentElement, Styled, Window, div,
	motion::{AnimatorRegistry, FrameInstant, MotionDriver},
};
use veyyon_desktop_ui::theme::motion;

/// The entries the list has held and the reveal of each entry still moving.
#[derive(Default)]
pub(super) struct Reveal {
	hasher:  RandomState,
	/// Every entry the list has held since the transcript was last drawn
	/// whole, by hashed id.
	seen:    HashSet<u64>,
	/// Each revealing entry's reveal, 0 hidden to 1 shown.
	reveals: AnimatorRegistry<u64, FrameInstant>,
	driver:  MotionDriver,
}

impl Reveal {
	/// Records `ids` as the whole transcript, drawn at rest.
	pub(super) fn reset<'a>(&mut self, ids: impl Iterator<Item = &'a str>) {
		self.seen.clear();
		self.reveals.clear();
		let hasher = &self.hasher;
		self.seen.extend(ids.map(|id| hasher.hash_one(id)));
	}

	/// Records entry `id` as held by the list. An entry the list did not hold
	/// before reveals when `reveal` is set.
	pub(super) fn land(&mut self, id: &str, reveal: bool, cx: &App) {
		let key = self.hasher.hash_one(id);
		if !self.seen.insert(key) || !reveal {
			return;
		}
		let policy = cx.motion_policy();
		if !policy.reduced() {
			self
				.reveals
				.animate(key, 0.0, 1.0, motion::REVEAL, policy, cx.frame_instant());
		}
	}

	/// Advances every revealing entry to this frame and requests the next
	/// frame while one moves.
	pub(super) fn step(&mut self, window: &mut Window, cx: &App) {
		if self.reveals.is_empty() {
			return;
		}
		let mut frame = self.driver.begin(cx);
		frame.track(&mut self.reveals);
		self.driver.end(frame, window);
		self.reveals.retain_active();
	}

	/// `element`, entry `id`, drawn where its reveal has it this frame.
	pub(super) fn place(&self, id: &str, element: AnyElement) -> AnyElement {
		if self.reveals.is_empty() {
			return element;
		}
		let shown = self
			.reveals
			.get(&self.hasher.hash_one(id))
			.map_or(1.0, |reveal| reveal.value().clamp(0.0, 1.0));
		if shown >= 1.0 {
			return element;
		}
		// A list item is laid out as a root, which ignores its own inset, so
		// the offset goes on a child.
		div()
			.w_full()
			.child(
				div()
					.w_full()
					.relative()
					.top(motion::REVEAL_RISE * (1.0 - shown))
					.opacity(shown)
					.child(element),
			)
			.into_any_element()
	}
}
