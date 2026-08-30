//! The frame's instant, and the one motion registry the window draws with.
//!
//! [`motion`](crate::motion) is pure: every function there takes `now` and
//! nothing reads a clock. That is what makes a tween testable at an exact
//! millisecond. This module is the other half: it holds the registry and the
//! instant as globals, so a control deep inside a surface can fade its own
//! hover without the surface it sits in threading a registry, a clock and a
//! palette down to it.
//!
//! ONE INSTANT PER FRAME. [`Clock::frame`] returns the instant the frame began,
//! sampled once by the shell in [`begin`], not the instant it is called. Two
//! values read at opposite ends of one render are therefore evaluated at the
//! same time, which is the property the whole motion layer rests on.
//! [`Clock::live`] is the other case: an event arrives between frames, and its
//! motion starts when the pointer moved rather than at the next frame's clock.

use std::time::Instant;

use gpui::{App, Global, Hsla, Window};

use crate::motion::{self, Key, Motion, Spec};

/// When the window opened, and when this frame began.
pub struct Clock {
	opened: Instant,
	frame:  u64,
}

impl Global for Clock {}
impl Global for Motion {}

impl Default for Clock {
	fn default() -> Clock {
		Clock { opened: Instant::now(), frame: 0 }
	}
}

impl Clock {
	/// Start the window's clock. Called once, before the first frame, so the
	/// instant the first frame is drawn at is near zero rather than near
	/// whenever a control first asked for it.
	pub fn start(cx: &mut App) {
		cx.set_global(Clock::default());
	}

	/// The instant this frame is being drawn at, in milliseconds since the
	/// window opened.
	pub fn frame(cx: &App) -> u64 {
		cx.try_global::<Clock>()
			.map(|clock| clock.frame)
			.unwrap_or(0)
	}

	/// The instant right now, for something that happened between frames.
	pub fn live(cx: &App) -> u64 {
		match cx.try_global::<Clock>() {
			Some(clock) => clock.opened.elapsed().as_millis() as u64,
			None => 0,
		}
	}
}

/// Begin a frame: sample the clock once, and take the platform's reduced-motion
/// setting.
///
/// Returns the frame's instant, for a caller that wants it for its own
/// arithmetic.
pub fn begin(reduced: bool, cx: &mut App) -> u64 {
	let now = Clock::live(cx);
	cx.default_global::<Clock>().frame = now;
	registry(cx).set_reduced(reduced);
	now
}

/// End a frame: retire the channels nobody read, and ask for another frame if
/// anything is still moving.
///
/// The window asks for exactly as many frames as the motion needs and no more,
/// which is why an idle window costs nothing.
pub fn end(window: &Window, cx: &mut App) {
	let now = Clock::frame(cx);
	let moving = registry(cx).advance(now);
	if moving {
		window.request_animation_frame();
	}
}

/// The registry itself, for the callers that drive a channel directly: a drag
/// that snaps a width, a surface that folds a group.
pub fn registry(cx: &mut App) -> &mut Motion {
	cx.default_global::<Motion>()
}

/// Where a channel is at this frame's instant. Creates nothing.
pub fn at(cx: &mut App, key: Key) -> f32 {
	let now = Clock::frame(cx);
	registry(cx).value(key, now)
}

/// The ground a hoverable surface takes this frame, blended rather than
/// snapped.
///
/// gpui's own `.hover()` applies its style the frame the pointer arrives, which
/// is a step change; every other application on the machine fades it over
/// 150ms.
pub fn wash(cx: &mut App, key: Key, rest: Hsla, hovered: Hsla) -> Hsla {
	motion::mix(rest, hovered, at(cx, key))
}

/// How far through its arrival an element is, on first appearance.
pub fn arriving(cx: &mut App, key: Key, spec: Spec) -> f32 {
	let now = Clock::frame(cx);
	registry(cx).enter(key, spec, now)
}

/// A value on its way to `target`.
pub fn toward(cx: &mut App, key: Key, spec: Spec, target: f32) -> f32 {
	let now = Clock::frame(cx);
	registry(cx).drive(key, spec, target, now)
}

/// A value that turns for as long as it is read.
pub fn spinning(cx: &mut App, key: Key) -> f32 {
	let now = Clock::frame(cx);
	registry(cx).spinning(key, now)
}

/// A pointer arrived at, or left, something that washes.
///
/// Called from an `on_hover` listener, which runs between frames: the motion
/// starts when the pointer moved.
pub fn hover(cx: &mut App, key: Key, on: bool) {
	let now = Clock::live(cx);
	registry(cx).flip(key, on, motion::WASH, now);
}

/// Something was folded or unfolded, from an event listener.
pub fn flip(cx: &mut App, key: Key, on: bool, spec: Spec) {
	let now = Clock::live(cx);
	registry(cx).flip(key, on, spec, now);
}
