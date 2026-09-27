//! Motion drivers for the veyyon desktop surfaces.
//!
//! Each driver composes `gpui::motion` animators into the motion one kind of
//! surface element runs: a float's rise and fade, a panel's drag and release,
//! a section's reveal, a row's shift, a programmatic scroll, a tint and the
//! streaming caret. The role table, easing curves, springs, reduced-motion
//! resolution and frame driving are `gpui::motion`'s; a driver selects a
//! role's motion with `resolve_motion` and runs it on an `Animator`.
//!
//! Every driver implements `Advance`, so a view tracks it with a
//! `MotionFrame` and the frame requests the next animation frame while the
//! driver moves.

pub mod drivers;

pub use drivers::{
	CaretMotion, FloatFrame, FloatMotion, PanelMotion, RevealMotion, ScrollMotion, ShiftMotion,
	TintMotion,
};
