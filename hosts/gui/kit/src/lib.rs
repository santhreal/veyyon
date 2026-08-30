//! Tokens, and the pieces every surface is built from.
//!
//! A primitive here takes what it needs to draw and a callback for what a press
//! does. It reads no store and holds no state, because what it looks like is a
//! function of its arguments and the frame's instant. That is what lets a
//! surface be moved, split or replaced without touching anything it draws with.
//!
//! Colour, type, space, radius, elevation and motion each have exactly one
//! owner in [`theme`] and [`motion`]. A literal outside them is a token that
//! has not been named yet.

pub mod input;
pub mod motion;
pub mod paint;
pub mod theme;
pub mod ui;
