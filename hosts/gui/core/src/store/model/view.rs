//! What is on screen, and what floats over it.
//!
//! Two questions, kept apart on purpose. A route is what fills the main panel
//! and survives until something else is asked for; an overlay is on top of
//! whatever the route is and closes on Escape. Folding the two into one enum
//! would make opening a palette over settings a state nobody can name.

use super::SettingsPage;

/// What fills the main panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
	/// The selected conversation.
	Chat,
	/// A settings page.
	Settings(SettingsPage),
}

/// The open palette: the query, and where the cursor is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Palette {
	pub query:    String,
	pub selected: usize,
}

/// What floats over the window, if anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Overlay {
	None,
	Palette(Palette),
}

impl Overlay {
	pub fn palette(&self) -> Option<&Palette> {
		match self {
			Overlay::Palette(palette) => Some(palette),
			Overlay::None => None,
		}
	}

	pub fn is_open(&self) -> bool {
		!matches!(self, Overlay::None)
	}
}

/// Whether an engine is attached, and to what.
///
/// The window is honest about this everywhere it matters: the transcript's tail
/// says nothing answers, and no surface draws a reply that does not exist.
/// Nothing sets anything but [`Engine::Detached`] yet, and the states are here
/// because attaching one is a state change rather than a new shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Engine {
	/// Nothing is attached. What the window opens as.
	Detached,
	/// Starting, or reconnecting.
	Connecting,
	/// Attached: what it is, and the model it answers with.
	Attached { what: String, model: String },
}

impl Engine {
	/// The one line a header can print about this.
	pub fn what(&self) -> String {
		match self {
			Engine::Detached => "No engine attached".to_owned(),
			Engine::Connecting => "Attaching".to_owned(),
			Engine::Attached { what, model } => format!("{what} · {model}"),
		}
	}

	pub fn is_attached(&self) -> bool {
		matches!(self, Engine::Attached { .. })
	}
}
