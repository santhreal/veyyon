//! How long a motion takes, and the catalog of motions.
//!
//! A duration is named after what moves, not after its length, so two things
//! that must agree cannot drift apart in two call sites.

use super::curve::{COLOR, Curve, EASE, EXPO_OUT, IN, IN_OUT, LINEAR, OUT};

/// One motion: how long, along which curve.
///
/// There is no delay field. Nothing in the window waits before it starts
/// moving, and a stagger built out of per-element delays is a stagger that has
/// to be kept in step by hand.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Spec {
	pub duration_ms: u32,
	pub curve:       Curve,
}

impl Spec {
	pub const fn new(duration_ms: u32, curve: Curve) -> Spec {
		Spec { duration_ms, curve }
	}

	/// Eased progress `elapsed` milliseconds in.
	pub fn at_ms(self, elapsed_ms: u32) -> f32 {
		if self.duration_ms == 0 {
			return 1.0;
		}
		self.curve.at(elapsed_ms as f32 / self.duration_ms as f32)
	}
}

/// A card, a row or a message appearing: 260ms, fast out of the gate.
pub const ENTER: Spec = Spec::new(260, EXPO_OUT);
/// A fade with nothing else attached.
pub const FADE: Spec = Spec::new(150, EASE);
/// A pane's width or a panel's height.
pub const RESIZE: Spec = Spec::new(200, OUT);
/// A group folding or unfolding.
pub const COLLAPSE: Spec = Spec::new(180, OUT);
/// A sheet arriving over the window.
pub const SHEET_IN: Spec = Spec::new(180, EASE);
/// A sheet leaving. Shorter than it arrives: waiting for something to go is
/// dead time.
pub const SHEET_OUT: Spec = Spec::new(110, IN);

// A sheet's exit stays shorter than its entrance: waiting for something to go
// is dead time, and retiming either constant past the other reads as a stall.
const _: () = assert!(SHEET_OUT.duration_ms < SHEET_IN.duration_ms);

/// A hover wash. The browser's `transition-colors` default, which is what the
/// eye is calibrated to from every other application on the machine.
pub const WASH: Spec = Spec::new(150, COLOR);
/// A knob travelling from one end of its track to the other. Slower than a
/// fade, because the travel is the whole of what it says.
pub const GLIDE: Spec = Spec::new(220, IN_OUT);
/// One turn of an indeterminate indicator.
pub const SPIN: Spec = Spec::new(900, LINEAR);
/// The caret's half-period.
pub const BLINK_MS: u32 = 530;
