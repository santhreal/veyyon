use serde::{Deserialize, Serialize};

/// Single visual color theme definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeView {
	/// Unique theme identifier.
	pub id:   String,
	/// Display name.
	pub name: String,
	/// Flag indicating whether this is a dark theme.
	pub dark: bool,
}

/// Available themes and currently active theme identifier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemesView {
	/// List of all installed themes.
	pub themes:  Vec<ThemeView>,
	/// Identifier of the currently active theme.
	pub current: String,
}

/// Keyboard shortcut binding configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeybindingView {
	/// Target action name triggered by this binding.
	pub action: String,
	/// Key sequence combination strings (e.g. `["ctrl+enter"]`).
	pub keys:   Vec<String>,
	/// Configuration source (e.g. "default", "user").
	pub source: String,
}
