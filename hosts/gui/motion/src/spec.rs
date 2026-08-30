//! Duration tokens.
//!
//! A [`Motion`] is a duration, an optional delay and a curve. The catalog at
//! the bottom of this file is the complete set a veyyon surface may use; a
//! component that needs a duration takes one of these rather than naming
//! milliseconds, so retiming the product is an edit here.
//!
//! Delay is folded into the timeline because gpui's `Animation` has no delay of
//! its own: the animation runs for `delay + duration` and [`Motion::progress`]
//! holds at 0 until the delay has elapsed.

use std::{
	sync::atomic::{AtomicU32, Ordering},
	time::Duration,
};

use gpui::Animation;

use crate::curve::{Curve, EASE, EASE_IN_OUT, EASE_OUT, EXPO_OUT, LINEAR, STANDARD};

/// Wall-clock multiplier applied to every [`Motion::animation`].
///
/// 1.0 in the product. Raised when recording proof frames, where a 140ms
/// popover entrance is four frames at 30fps and cannot be seen. It scales
/// wall-clock time only — curves, delays and the ratios between tokens are
/// unchanged, so a slowed capture shows the real shape.
static SPEED_SCALE_BITS: AtomicU32 = AtomicU32::new(1.0_f32.to_bits());

pub fn speed_scale() -> f32 {
	f32::from_bits(SPEED_SCALE_BITS.load(Ordering::Relaxed))
}

/// Sets the wall-clock multiplier. Non-finite and non-positive values are
/// ignored, because a zero or negative duration makes gpui divide by it.
pub fn set_speed_scale(scale: f32) {
	if scale.is_finite() && scale > 0.0 {
		SPEED_SCALE_BITS.store(scale.to_bits(), Ordering::Relaxed);
	}
}

/// One catalog entry: how long, after how long, along which curve.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Motion {
	pub duration_ms: u64,
	pub delay_ms:    u64,
	pub curve:       Curve,
}

impl Motion {
	pub const fn new(duration_ms: u64, curve: Curve) -> Self {
		Self { duration_ms, delay_ms: 0, curve }
	}

	pub const fn after(mut self, delay_ms: u64) -> Self {
		self.delay_ms = delay_ms;
		self
	}

	/// Delay plus duration: the span the gpui animation actually occupies.
	pub const fn span(&self) -> Duration {
		Duration::from_millis(self.delay_ms + self.duration_ms)
	}

	/// Eased progress for a raw timeline delta, where the delta runs 0..1
	/// across [`span`](Self::span) rather than across the duration.
	///
	/// Pure: this is where the timing is tested, with no window and no clock.
	pub fn progress(&self, raw: f32) -> f32 {
		if self.duration_ms == 0 {
			return 1.0;
		}
		let span = (self.delay_ms + self.duration_ms) as f32;
		let elapsed = raw.clamp(0.0, 1.0) * span;
		let t = (elapsed - self.delay_ms as f32) / self.duration_ms as f32;
		self.curve.eval(t.clamp(0.0, 1.0))
	}

	/// A one-shot gpui animation for this token, with the delay folded in and
	/// [`speed_scale`] applied.
	pub fn animation(&self) -> Animation {
		let motion = *self;
		Animation::new(motion.span().mul_f32(speed_scale()))
			.with_easing(move |raw| motion.progress(raw))
	}

	/// A repeating animation over the raw span, phase-locked to a clock shared
	/// by the whole app so several instances of one loader stay in step.
	///
	/// Easing is linear here on purpose: a repeating loader eases per element
	/// inside its animator, from the phase this hands it. Capped at 30fps —
	/// without a cap a mounted loader asks for a redraw every display frame, so
	/// one spinner holds the whole window at the refresh rate.
	pub fn repeating(&self) -> Animation {
		Animation::new(self.span())
			.repeat_synced()
			.with_max_fps(LOADER_FPS)
	}
}

/// Redraw ceiling for repeating loaders. Chunky opacity waves are visually
/// identical at 30fps and cost a quarter of the frames.
pub const LOADER_FPS: f32 = 30.0;

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/// A transcript block arriving. Short on purpose: blocks land continuously
/// while a turn streams, and an entrance long enough to notice once is an
/// entrance that never stops happening.
pub const BLOCK_IN: Motion = Motion::new(220, EXPO_OUT);

/// Opacity-only fade for something replacing something else in place.
pub const FADE: Motion = Motion::new(120, EASE);

/// Popover, menu and completion list entrance.
pub const MENU_IN: Motion = Motion::new(140, EASE);

/// Popover exit. Shorter than its entrance: an entrance is showing you
/// something, an exit is getting out of the way.
pub const MENU_OUT: Motion = Motion::new(90, EASE);

/// Modal dialog entrance.
pub const DIALOG_IN: Motion = Motion::new(180, EASE);

/// Modal dialog exit.
pub const DIALOG_OUT: Motion = Motion::new(120, EASE);

/// Hover and focus washes. Matches the web's default transition so an
/// interactive surface here feels like one in a browser.
pub const WASH: Motion = Motion::new(130, STANDARD);

/// Pane, sidebar and split resize.
pub const RESIZE: Motion = Motion::new(200, EASE_OUT);

/// Disclosure: a tool card or diff hunk expanding and collapsing.
pub const DISCLOSE: Motion = Motion::new(180, EASE_OUT);

/// Scroll-to-row and jump-to-live glide. Fixed duration over the whole
/// distance, so the landing is the same regardless of how far it travelled.
pub const SCROLL_GLIDE: Motion = Motion::new(400, EASE_IN_OUT);

/// Working indicator period. Linear because each cell eases its own phase.
pub const WORKING_PULSE: Motion = Motion::new(1800, LINEAR);

/// Streaming caret period.
pub const CARET_BLINK: Motion = Motion::new(1060, LINEAR);

/// Boot splash exit: hold, then leave.
pub const SPLASH_OUT: Motion = Motion::new(320, EASE).after(120);

#[cfg(test)]
mod tests {
	use super::*;

	const CATALOG: &[(&str, Motion)] = &[
		("BLOCK_IN", BLOCK_IN),
		("FADE", FADE),
		("MENU_IN", MENU_IN),
		("MENU_OUT", MENU_OUT),
		("DIALOG_IN", DIALOG_IN),
		("DIALOG_OUT", DIALOG_OUT),
		("WASH", WASH),
		("RESIZE", RESIZE),
		("DISCLOSE", DISCLOSE),
		("SCROLL_GLIDE", SCROLL_GLIDE),
		("WORKING_PULSE", WORKING_PULSE),
		("CARET_BLINK", CARET_BLINK),
		("SPLASH_OUT", SPLASH_OUT),
	];

	/// Every token starts at 0 and finishes at 1. A token that does not reach 1
	/// leaves whatever it animates permanently short of its end state.
	#[test]
	fn every_token_runs_from_zero_to_one() {
		for (name, motion) in CATALOG {
			assert_eq!(motion.progress(0.0), 0.0, "{name} at 0");
			assert_eq!(motion.progress(1.0), 1.0, "{name} at 1");
		}
	}

	/// Progress is monotonic across the whole timeline, delay included.
	#[test]
	fn progress_never_moves_backwards() {
		for (name, motion) in CATALOG {
			let mut previous = 0.0;
			for step in 0..=500 {
				let value = motion.progress(step as f32 / 500.0);
				assert!(value >= previous - 1e-5, "{name} fell from {previous} to {value}");
				previous = value;
			}
		}
	}

	/// A delay holds progress at exactly 0 until it elapses, then the curve
	/// runs over the remaining span. Without this, a delayed token starts
	/// mid-curve and the hold is invisible.
	#[test]
	fn a_delay_holds_at_zero_then_runs_the_full_curve() {
		let motion = Motion::new(300, EASE).after(100);
		assert_eq!(motion.span(), Duration::from_millis(400));

		// The delay is the first quarter of a 400ms span.
		assert_eq!(motion.progress(0.0), 0.0);
		assert_eq!(motion.progress(0.124), 0.0);
		assert_eq!(motion.progress(0.25), 0.0);

		// And the curve occupies the rest of it.
		assert!(motion.progress(0.30) > 0.0, "just after the delay");
		assert!(motion.progress(0.625) > 0.4, "midpoint of the duration");
		assert_eq!(motion.progress(1.0), 1.0);
	}

	/// `SPLASH_OUT` is the only token in the catalog with a delay, and its span
	/// is the sum. Pinned by equality so a token that gains a delay without one
	/// being intended shows up here.
	#[test]
	fn splash_out_is_the_only_delayed_token() {
		let delayed: Vec<&str> = CATALOG
			.iter()
			.filter(|(_, motion)| motion.delay_ms > 0)
			.map(|(name, _)| *name)
			.collect();
		assert_eq!(delayed, ["SPLASH_OUT"]);
		assert_eq!(SPLASH_OUT.span(), Duration::from_millis(440));
	}

	/// An exit is quicker than the entrance it reverses. This is a product
	/// rule, not an accident of the numbers, so it is asserted.
	#[test]
	fn exits_are_quicker_than_their_entrances() {
		const { assert!(MENU_OUT.duration_ms < MENU_IN.duration_ms) };
		const { assert!(DIALOG_OUT.duration_ms < DIALOG_IN.duration_ms) };
	}

	/// A zero duration resolves immediately instead of dividing by zero.
	#[test]
	fn a_zero_duration_is_already_finished() {
		let motion = Motion::new(0, EASE);
		assert_eq!(motion.progress(0.0), 1.0);
		assert_eq!(motion.progress(0.5), 1.0);
	}

	/// Out-of-range deltas clamp rather than extrapolating. gpui should never
	/// hand one over, and a curve evaluated outside 0..1 is undefined.
	#[test]
	fn out_of_range_deltas_clamp() {
		assert_eq!(BLOCK_IN.progress(-1.0), 0.0);
		assert_eq!(BLOCK_IN.progress(4.0), 1.0);
	}

	/// The speed scale rejects values that would produce a zero or backwards
	/// duration, and keeps the last good one.
	#[test]
	fn the_speed_scale_rejects_unusable_values() {
		set_speed_scale(2.5);
		assert_eq!(speed_scale(), 2.5);

		for bad in [0.0, -1.0, f32::NAN, f32::INFINITY] {
			set_speed_scale(bad);
			assert_eq!(speed_scale(), 2.5, "accepted {bad}");
		}

		set_speed_scale(1.0);
	}
}
