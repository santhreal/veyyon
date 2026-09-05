//! The presentation mirror of every keyboard action (§5.14).
//!
//! `Command` is what the palette and the keybindings page show: one row per
//! action, with a label and the scope its chord applies in. The actions
//! themselves are in `actions.rs`; `from_name` is the join from a TOML
//! binding's action name back to the row.

use strum::EnumIter;

use super::actions::Scope;

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
