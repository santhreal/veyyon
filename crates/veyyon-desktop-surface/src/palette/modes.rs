//! Palette modes and navigation (§5.8).
//!
//! The command palette operates in six modes: commands, open sessions,
//! workspace files, text content search, directory browsing for project
//! selection, and the model catalog the composer's model control opens.

use strum::EnumIter;

/// Operational mode of the command palette (§5.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, EnumIter)]
pub enum PaletteMode {
	/// Execution of shell actions and operator commands.
	Commands,
	/// Navigation across active, pinned, and deferred sessions.
	Sessions,
	/// File lookup across the workspace tree.
	Files,
	/// Full text search across file contents.
	ContentSearch,
	/// Directory navigation for adding or switching project roots.
	Browse,
	/// The host's model catalog, opened from the composer's model control.
	Models,
}

impl PaletteMode {
	/// Human-readable title of the mode displayed in group headers.
	#[must_use]
	pub const fn label(self) -> &'static str {
		match self {
			Self::Commands => "Commands",
			Self::Sessions => "Sessions",
			Self::Files => "Files",
			Self::ContentSearch => "Content Search",
			Self::Browse => "Browse Project",
			Self::Models => "Models",
		}
	}

	/// Input placeholder text prompting the operator for this mode.
	#[must_use]
	pub const fn placeholder(self) -> &'static str {
		match self {
			Self::Commands => "Type a command or filter actions...",
			Self::Sessions => "Search active and recent sessions...",
			Self::Files => "Search files by name...",
			Self::ContentSearch => "Search file contents...",
			Self::Browse => "Navigate directories (Enter descends, Backspace ascends)...",
			Self::Models => "Search models by name or provider...",
		}
	}

	/// Whether this mode supports ascending directory hierarchy on empty query.
	#[must_use]
	pub const fn supports_ascend(self) -> bool {
		matches!(self, Self::Browse)
	}
}
