//! The veyyon motion catalog.
//!
//! Four things live here and nothing else does:
//!
//! - [`Curve`] — timing curves, as the four numbers CSS `cubic-bezier` takes.
//! - [`Motion`] — duration tokens. A component names a token; it never names
//!   milliseconds.
//! - [`spring`] — spring presets, for motion an interaction can interrupt.
//! - [`element`] — one-line wrappers that apply either to a gpui element.
//!
//! # Choosing between a token and a spring
//!
//! A token has a duration, so it has an end. Use one when nothing will
//! interrupt the motion: an entrance, an exit, a scroll glide, a disclosure.
//!
//! A spring has a target, so it can be retargeted. Use one when an interaction
//! drives it and can reverse before it arrives: hover, press, drag, reorder.
//! Retargeting a token restarts it and the motion visibly stutters; retargeting
//! a spring preserves its velocity.
//!
//! # What this crate does not do
//!
//! It does not integrate springs, schedule frames, share a clock between
//! loaders, or cap a frame rate. gpui does all of that:
//! `AnimationExt::with_spring` carries spring state across retargets by element
//! id, `Animation::repeat_synced` phase-locks every repeat in the app to one
//! clock, and `Animation::with_max_fps` caps redraws. This crate is the
//! catalogue of values fed into those, plus the arithmetic that has to be
//! testable without a window.

pub mod curve;
pub mod element;
pub mod phase;
pub mod spec;
pub mod spring;

pub use curve::{Curve, EASE, EASE_IN_OUT, EASE_OUT, EXPO_OUT, LINEAR, STANDARD};
pub use element::{
	blend, dialog_in, enter, fade_in, leave, lift, menu_in, reveal_height, reveal_width, rise_in,
	wash,
};
/// gpui's own animation surface, re-exported so a component needs one import.
pub use gpui::{Animation, AnimationExt, SpringAnimation, SpringConfig};
pub use spec::{
	BLOCK_IN, CARET_BLINK, DIALOG_IN, DIALOG_OUT, DISCLOSE, FADE, LOADER_FPS, MENU_IN, MENU_OUT,
	Motion, RESIZE, SCROLL_GLIDE, SPLASH_OUT, WASH, WORKING_PULSE, set_speed_scale, speed_scale,
};
