//! Overlay modal layer enumeration and state models (§5.8, §5.9).
//!
//! Renders modal floating dialogs (Command Palette, Settings) above the
//! columns row over a blurred backdrop scrim.

pub use crate::{palette::PaletteState, settings::SettingsState};

/// Floating overlay active above the main shell columns (§5.8, §5.9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Overlay {
	/// Command palette overlay for fuzzy searching commands, sessions, and
	/// files.
	Palette(PaletteState),
	/// Settings overlay for host configuration, themes, and diagnostics.
	/// Boxed: the settings state dwarfs the palette's and rides on the heap.
	Settings(Box<SettingsState>),
}

impl Overlay {
	/// Returns true if this overlay is the command palette.
	#[must_use]
	pub const fn is_palette(&self) -> bool {
		matches!(self, Self::Palette(_))
	}

	/// Returns true if this overlay is the settings dialog.
	#[must_use]
	pub const fn is_settings(&self) -> bool {
		matches!(self, Self::Settings(_))
	}

	/// Returns a reference to the palette state if active.
	#[must_use]
	pub const fn as_palette(&self) -> Option<&PaletteState> {
		match self {
			Self::Palette(state) => Some(state),
			Self::Settings(_) => None,
		}
	}

	/// Returns a mutable reference to the palette state if active.
	#[must_use]
	pub const fn as_palette_mut(&mut self) -> Option<&mut PaletteState> {
		match self {
			Self::Palette(state) => Some(state),
			Self::Settings(_) => None,
		}
	}

	/// Returns a reference to the settings state if active.
	#[must_use]
	pub const fn as_settings(&self) -> Option<&SettingsState> {
		match self {
			Self::Settings(state) => Some(state),
			Self::Palette(_) => None,
		}
	}

	/// Returns a mutable reference to the settings state if active.
	#[must_use]
	pub const fn as_settings_mut(&mut self) -> Option<&mut SettingsState> {
		match self {
			Self::Settings(state) => Some(state),
			Self::Palette(_) => None,
		}
	}
}
