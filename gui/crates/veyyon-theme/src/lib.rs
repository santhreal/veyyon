#![allow(
	clippy::tabs_in_doc_comments,
	reason = "the workspace sets hard_tabs and rustfmt applies it inside doc-comment code blocks, \
	          which is what this lint objects to. Both cannot hold, and the formatter is the \
	          enforced gate while this lint is style-only."
)]

//! Veyyon's theme layer for the GPU front end.
//!
//! One theme format for both front ends. A theme file is written for the
//! terminal — `vars`, `colors`, `export` — and this crate reads it and produces
//! the colours a window needs, deriving the surfaces a terminal has no concept
//! of. The 98 bundled themes are embedded from the coding-agent package at
//! build time rather than copied, so a theme edited for the terminal is edited
//! for the GUI.
//!
//! ```no_run
//! use veyyon_theme::{Role, builtin};
//!
//! let palette = builtin::load("dark-gruvbox")
//! 	.expect("bundled")
//! 	.expect("resolves");
//! let ground = palette[Role::SurfaceWindow];
//! let text = palette[Role::TextPrimary];
//! ```
//!
//! A theme an operator wrote goes through the same path:
//!
//! ```no_run
//! use veyyon_theme::Palette;
//!
//! # fn main() -> Result<(), veyyon_theme::ThemeError> {
//! # let json = "{}";
//! let palette = Palette::parse("mine", json)?;
//! # Ok(())
//! # }
//! ```
//!
//! # What is here and what is not
//!
//! Colour only. No fonts, no spacing, no radii: those are the same on every
//! theme, so they belong to the UI crate that draws with them rather than to a
//! per-theme file. A theme changes what colour a surface is, never how large it
//! is.

pub mod builtin;
pub mod color;
pub mod file;
pub mod palette;
pub mod role;

pub use color::{ColorError, Srgb};
pub use file::{ColorValue, Group, ThemeError, ThemeFile};
pub use palette::{Appearance, Palette};
pub use role::Role;
