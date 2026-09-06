//! Action declarations for the keyboard model (§5.14).
//!
//! Every chord in the product maps to one action declared here. Discrete
//! actions without arguments are declared as unit structs via the `actions!`
//! macro; parameterized actions derive `Action` directly. `command::Command`
//! mirrors each action with a label and a scope for the palette and the
//! settings page.

use serde::{Deserialize, Serialize};
use strum::EnumIter;
use veyyon_gpui as gpui;
use veyyon_gpui::actions;

/// The region context a binding belongs to (§5.14).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, EnumIter)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
	/// Window-wide bindings available regardless of focus.
	Global,
	/// Bindings active when the queue rail is focused.
	Queue,
	/// Bindings active when the transcript column is focused.
	Transcript,
	/// Bindings active when the composer is focused.
	Composer,
	/// Bindings active when the right panel is focused.
	Panel,
}

impl Scope {
	/// Returns the identifier string for this scope.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Global => "global",
			Self::Queue => "queue",
			Self::Transcript => "transcript",
			Self::Composer => "composer",
			Self::Panel => "panel",
		}
	}

	/// Returns the GPUI key context string for this scope.
	#[must_use]
	pub const fn context_name(self) -> &'static str {
		match self {
			Self::Global => "Global",
			Self::Queue => "Queue",
			Self::Transcript => "Transcript",
			Self::Composer => "Composer",
			Self::Panel => "Panel",
		}
	}

	/// Parses a scope from its case-insensitive name.
	#[must_use]
	pub const fn from_name(name: &str) -> Option<Self> {
		if name.eq_ignore_ascii_case("global") {
			Some(Self::Global)
		} else if name.eq_ignore_ascii_case("queue") {
			Some(Self::Queue)
		} else if name.eq_ignore_ascii_case("transcript") {
			Some(Self::Transcript)
		} else if name.eq_ignore_ascii_case("composer") {
			Some(Self::Composer)
		} else if name.eq_ignore_ascii_case("panel") {
			Some(Self::Panel)
		} else {
			None
		}
	}
}

// Unit actions across all five scopes (§5.14). Each entry derives `Eq` by
// hand because the vendored macro derives `PartialEq` alone.
actions!([
	#[derive(Eq)]
	OpenPalette,
	#[derive(Eq)]
	NewSession,
	#[derive(Eq)]
	OpenSettings,
	#[derive(Eq)]
	ToggleQueue,
	#[derive(Eq)]
	ToggleDrawer,
	#[derive(Eq)]
	TogglePanel,
	#[derive(Eq)]
	PreviousSession,
	#[derive(Eq)]
	NextSession,
	#[derive(Eq)]
	CloseTabOrPark,
	#[derive(Eq)]
	OpenSelectedSession,
	#[derive(Eq)]
	TogglePinSelected,
	#[derive(Eq)]
	ToggleDeferSelected,
	#[derive(Eq)]
	ToggleParkSelected,
	#[derive(Eq)]
	FilterQueue,
	#[derive(Eq)]
	FindInTranscript,
	#[derive(Eq)]
	PreviousTurn,
	#[derive(Eq)]
	NextTurn,
	#[derive(Eq)]
	ToggleBlock,
	#[derive(Eq)]
	Primary,
	#[derive(Eq)]
	Newline,
	#[derive(Eq)]
	SplitHalf,
	#[derive(Eq)]
	Dismiss,
	#[derive(Eq)]
	AbortTurn,
	#[derive(Eq)]
	ToggleQueueMode,
	#[derive(Eq)]
	ModelPicker,
	#[derive(Eq)]
	ThinkingLevel,
	#[derive(Eq)]
	AttachFile,
	#[derive(Eq)]
	PreviousTab,
	#[derive(Eq)]
	NextTab,
	#[derive(Eq)]
	ToggleDiffMode,
]);

/// Focuses the nth session in the Live queue partition.
#[derive(Clone, PartialEq, Eq, Debug, Deserialize, Serialize, veyyon_gpui::Action)]
#[action(no_json)]
pub struct FocusLive {
	/// 1-based index in the Live list.
	pub index: u8,
}

impl FocusLive {
	pub const NAME: &'static str = "FocusLive";
}

/// Moves selection up or down within the queue rail.
#[derive(Clone, PartialEq, Eq, Debug, Deserialize, Serialize, veyyon_gpui::Action)]
#[action(no_json)]
pub struct MoveSelection {
	/// Relative move delta (negative for up, positive for down).
	pub delta: i32,
}

impl MoveSelection {
	pub const NAME: &'static str = "MoveSelection";
}

/// Alias for `MoveSelection` for queue chords.
pub type MoveQueueSelection = MoveSelection;

/// Selects a structured option when a question card is attached.
#[derive(Clone, PartialEq, Eq, Debug, Deserialize, Serialize, veyyon_gpui::Action)]
#[action(no_json)]
pub struct SelectOption {
	/// 1-based option index.
	pub index: u8,
}

impl SelectOption {
	pub const NAME: &'static str = "SelectOption";
}

/// Target destination for scrolling transcript content.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScrollBy {
	/// Scroll up one page.
	PageUp,
	/// Scroll down one page.
	PageDown,
	/// Scroll to the start of the transcript.
	Top,
	/// Scroll to the end of the transcript.
	Bottom,
}

/// Scrolls the transcript viewport.
#[derive(Clone, PartialEq, Eq, Debug, Deserialize, Serialize, veyyon_gpui::Action)]
#[action(no_json)]
pub struct Scroll {
	/// Scroll direction and magnitude.
	pub by: ScrollBy,
}

impl Scroll {
	pub const NAME: &'static str = "Scroll";
}

/// Alias for `Scroll` for transcript chords.
pub type ScrollTranscript = Scroll;
