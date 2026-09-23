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

/// Installed themes, and the theme configured for each ground.
///
/// Two themes are configured at once, one per ground, which is the shape the
/// settings hold. Which of them is drawn is the window's own ground, so the
/// choice is made where that is known rather than stated here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemesView {
	/// List of all installed themes.
	pub themes: Vec<ThemeView>,
	/// Identifier of the theme configured for a dark ground.
	pub dark:   String,
	/// Identifier of the theme configured for a light ground.
	pub light:  String,
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
