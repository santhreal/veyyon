#![allow(
	clippy::tabs_in_doc_comments,
	reason = "the workspace sets hard_tabs and rustfmt applies it inside doc-comment code blocks, \
	          which is what this lint objects to. Both cannot hold, and the formatter is the \
	          enforced gate while this lint is style-only."
)]

//! Veyyon's GPU component kit.
//!
//! Three things, and the discipline that they are the only three:
//!
//! - [`theme`] holds the active palette. A component names a
//!   [`veyyon_gui_theme::Role`] and gets a colour; it never holds one.
//! - [`surface`] is the single ground primitive. Every filled region comes from
//!   [`surface::surface`], so adding a blurred backdrop or a shadow is one
//!   file.
//! - [`tokens`] holds every size. A theme changes colour, never layout, so a
//!   theme switch cannot move a pixel.
//!
//! [`fonts`] resolves the two families against what is installed, and [`text`]
//! binds text to a role and a step of the scale.
//!
//! # Installing
//!
//! ```no_run
//! use gpui::App;
//! use veyyon_gui_kit::{Typography, theme::Theme};
//!
//! fn setup(cx: &mut App) {
//! 	Theme::set_default(cx);
//! 	Typography::install(cx);
//! }
//! ```

pub mod chrome;
pub mod fonts;
pub mod surface;
pub mod text;
pub mod theme;
pub mod tokens;

pub use fonts::{ActiveTypography, Typography};
pub use surface::{Ground, Level, surface};
pub use theme::{ActiveTheme, Theme};
