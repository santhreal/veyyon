//! Time, curves, and every animated value in the window.
//!
//! One mechanism. A channel is a number on its way somewhere, addressed by a
//! [`Key`], and everything that moves is one: a pane's width, a panel's height,
//! a row's hover wash, a group's disclosure, a sheet arriving, a card's first
//! appearance, a chip's fade. The shell holds one [`Motion`], reads channels
//! while it builds the frame, and advances all of them once at the end.
//!
//! THE CLOCK IS AN ARGUMENT. Nothing here calls into the clock. Every function
//! takes `now`, in milliseconds since the window opened, which is the same
//! number `state::moves::tick` runs on. Two consequences, and both are the
//! reason for the shape:
//!
//! - Every value in one frame is evaluated at exactly one instant, so two
//!   things told to move together provably move together.
//! - The whole layer is tested at exact millisecond boundaries with no sleeping
//!   and no window. A test asserts where a tween is at 100ms because it says
//!   100, not because it slept and hoped.
//!
//! WHAT IS NOT HERE. gpui's `with_animation` and its friends. That element
//! keys its start time by the element-id path, so an ancestor remount replays
//! the animation from zero, which is a full-brightness flash in the middle of a
//! fade. Every value here is evaluated from the shell's own clock instead, so a
//! remount is exactly the steady state and the element tree's shape is free to
//! change.

mod blend;
mod channel;
mod curve;
mod registry;
mod spec;

pub use blend::{lerp, mix};
pub use channel::{Channel, Key};
pub use curve::{COLOR, Curve, EASE, EXPO_OUT, IN, IN_OUT, LINEAR, OUT};
pub use registry::Motion;
pub use spec::{
	BLINK_MS, COLLAPSE, ENTER, FADE, GLIDE, RESIZE, SHEET_IN, SHEET_OUT, SPIN, Spec, WASH,
};

#[cfg(test)]
mod tests;
