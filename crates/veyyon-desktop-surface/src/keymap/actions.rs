//! Action declarations and command metadata for the keyboard model (§5.14).
//!
//! Every chord in the product maps to one action declared here. Discrete
//! actions without arguments are declared as unit structs via the `actions!`
//! macro; parameterized actions derive `Action` directly. The `Command` enum
//! mirrors each action with human-readable labels and scope tags for rendering
//! in the command palette and the settings page.

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

/// Mirror of all registered keyboard commands for presentation in settings and
/// palettes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, EnumIter)]
pub enum Command {
	OpenPalette,
	NewSession,
	OpenSettings,
	ToggleQueue,
	ToggleDrawer,
	TogglePanel,
	FocusLive,
	PreviousSession,
	NextSession,
	CloseTabOrPark,
	MoveSelection,
	OpenSelectedSession,
	TogglePinSelected,
	ToggleDeferSelected,
	ToggleParkSelected,
	FilterQueue,
	Scroll,
	FindInTranscript,
	PreviousTurn,
	NextTurn,
	ToggleBlock,
	Primary,
	Newline,
	SplitHalf,
	Dismiss,
	AbortTurn,
	ToggleQueueMode,
	SelectOption,
	ModelPicker,
	ThinkingLevel,
	AttachFile,
	PreviousTab,
	NextTab,
	ToggleDiffMode,
}

impl Command {
	/// Canonical action name matching the TOML binding.
	#[must_use]
	pub const fn name(self) -> &'static str {
		match self {
			Self::OpenPalette => "OpenPalette",
			Self::NewSession => "NewSession",
			Self::OpenSettings => "OpenSettings",
			Self::ToggleQueue => "ToggleQueue",
			Self::ToggleDrawer => "ToggleDrawer",
			Self::TogglePanel => "TogglePanel",
			Self::FocusLive => "FocusLive",
			Self::PreviousSession => "PreviousSession",
			Self::NextSession => "NextSession",
			Self::CloseTabOrPark => "CloseTabOrPark",
			Self::MoveSelection => "MoveSelection",
			Self::OpenSelectedSession => "OpenSelectedSession",
			Self::TogglePinSelected => "TogglePinSelected",
			Self::ToggleDeferSelected => "ToggleDeferSelected",
			Self::ToggleParkSelected => "ToggleParkSelected",
			Self::FilterQueue => "FilterQueue",
			Self::Scroll => "Scroll",
			Self::FindInTranscript => "FindInTranscript",
			Self::PreviousTurn => "PreviousTurn",
			Self::NextTurn => "NextTurn",
			Self::ToggleBlock => "ToggleBlock",
			Self::Primary => "Primary",
			Self::Newline => "Newline",
			Self::SplitHalf => "SplitHalf",
			Self::Dismiss => "Dismiss",
			Self::AbortTurn => "AbortTurn",
			Self::ToggleQueueMode => "ToggleQueueMode",
			Self::SelectOption => "SelectOption",
			Self::ModelPicker => "ModelPicker",
			Self::ThinkingLevel => "ThinkingLevel",
			Self::AttachFile => "AttachFile",
			Self::PreviousTab => "PreviousTab",
			Self::NextTab => "NextTab",
			Self::ToggleDiffMode => "ToggleDiffMode",
		}
	}

	/// Human-readable label describing the command's effect.
	#[must_use]
	pub const fn label(self) -> &'static str {
		match self {
			Self::OpenPalette => "Open command palette",
			Self::NewSession => "Create a new session",
			Self::OpenSettings => "Open application settings",
			Self::ToggleQueue => "Toggle queue rail",
			Self::ToggleDrawer => "Toggle terminal drawer",
			Self::TogglePanel => "Toggle right panel",
			Self::FocusLive => "Focus live session by index",
			Self::PreviousSession => "Select previous session",
			Self::NextSession => "Select next session",
			Self::CloseTabOrPark => "Close active panel tab or park session",
			Self::MoveSelection => "Move queue selection",
			Self::OpenSelectedSession => "Open selected session",
			Self::TogglePinSelected => "Pin or unpin selected session",
			Self::ToggleDeferSelected => "Defer or recall selected session",
			Self::ToggleParkSelected => "Park or unpark selected session",
			Self::FilterQueue => "Filter queue in place",
			Self::Scroll => "Scroll transcript",
			Self::FindInTranscript => "Find in transcript",
			Self::PreviousTurn => "Navigate to previous turn",
			Self::NextTurn => "Navigate to next turn",
			Self::ToggleBlock => "Expand or collapse focused block",
			Self::Primary => "Primary composer action",
			Self::Newline => "Insert newline in composer",
			Self::SplitHalf => "Non-primary half of split action",
			Self::Dismiss => "Dismiss topmost card or blur composer",
			Self::AbortTurn => "Abort in-flight turn",
			Self::ToggleQueueMode => "Toggle queue mode",
			Self::SelectOption => "Select question option",
			Self::ModelPicker => "Open model picker",
			Self::ThinkingLevel => "Cycle thinking level",
			Self::AttachFile => "Attach file to composer",
			Self::PreviousTab => "Select previous panel tab",
			Self::NextTab => "Select next panel tab",
			Self::ToggleDiffMode => "Toggle unified or split diff mode",
		}
	}

	/// The region scope where this command applies.
	#[must_use]
	pub const fn scope(self) -> Scope {
		match self {
			Self::OpenPalette
			| Self::NewSession
			| Self::OpenSettings
			| Self::ToggleQueue
			| Self::ToggleDrawer
			| Self::TogglePanel
			| Self::FocusLive
			| Self::PreviousSession
			| Self::NextSession
			| Self::CloseTabOrPark => Scope::Global,

			Self::MoveSelection
			| Self::OpenSelectedSession
			| Self::TogglePinSelected
			| Self::ToggleDeferSelected
			| Self::ToggleParkSelected
			| Self::FilterQueue => Scope::Queue,

			Self::Scroll
			| Self::FindInTranscript
			| Self::PreviousTurn
			| Self::NextTurn
			| Self::ToggleBlock => Scope::Transcript,

			Self::Primary
			| Self::Newline
			| Self::SplitHalf
			| Self::Dismiss
			| Self::AbortTurn
			| Self::ToggleQueueMode
			| Self::SelectOption
			| Self::ModelPicker
			| Self::ThinkingLevel
			| Self::AttachFile => Scope::Composer,

			Self::PreviousTab | Self::NextTab | Self::ToggleDiffMode => Scope::Panel,
		}
	}

	/// Resolves a command from its action name string.
	#[must_use]
	pub fn from_name(name: &str) -> Option<Self> {
		match name {
			"OpenPalette" => Some(Self::OpenPalette),
			"NewSession" => Some(Self::NewSession),
			"OpenSettings" => Some(Self::OpenSettings),
			"ToggleQueue" => Some(Self::ToggleQueue),
			"ToggleDrawer" => Some(Self::ToggleDrawer),
			"TogglePanel" => Some(Self::TogglePanel),
			"FocusLive" => Some(Self::FocusLive),
			"PreviousSession" => Some(Self::PreviousSession),
			"NextSession" => Some(Self::NextSession),
			"CloseTabOrPark" => Some(Self::CloseTabOrPark),
			"MoveSelection" | "MoveQueueSelection" => Some(Self::MoveSelection),
			"OpenSelectedSession" | "OpenSession" => Some(Self::OpenSelectedSession),
			"TogglePinSelected" | "PinSession" => Some(Self::TogglePinSelected),
			"ToggleDeferSelected" | "DeferSession" => Some(Self::ToggleDeferSelected),
			"ToggleParkSelected" | "ParkSession" => Some(Self::ToggleParkSelected),
			"FilterQueue" | "FocusFilter" => Some(Self::FilterQueue),
			"Scroll" | "ScrollTranscript" => Some(Self::Scroll),
			"FindInTranscript" => Some(Self::FindInTranscript),
			"PreviousTurn" => Some(Self::PreviousTurn),
			"NextTurn" => Some(Self::NextTurn),
			"ToggleBlock" => Some(Self::ToggleBlock),
			"Primary" => Some(Self::Primary),
			"Newline" => Some(Self::Newline),
			"SplitHalf" => Some(Self::SplitHalf),
			"Dismiss" => Some(Self::Dismiss),
			"AbortTurn" => Some(Self::AbortTurn),
			"ToggleQueueMode" => Some(Self::ToggleQueueMode),
			"SelectOption" => Some(Self::SelectOption),
			"ModelPicker" => Some(Self::ModelPicker),
			"ThinkingLevel" => Some(Self::ThinkingLevel),
			"AttachFile" => Some(Self::AttachFile),
			"PreviousTab" => Some(Self::PreviousTab),
			"NextTab" => Some(Self::NextTab),
			"ToggleDiffMode" => Some(Self::ToggleDiffMode),
			_ => None,
		}
	}
}
