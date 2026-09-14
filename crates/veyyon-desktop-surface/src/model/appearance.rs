//! Which appearance the window draws in (§6.9).
//!
//! Two names, not one. The chosen appearance is what the operator settled on
//! and what a relaunch comes back in; the previewed one is what the pointer is
//! resting on right now, drawn instead of the choice and dropped the moment
//! the pointer leaves the row. Holding them apart is what makes a preview
//! revertible: a preview that overwrote the choice would be indistinguishable
//! from a selection as soon as the pointer moved on.

use veyyon_desktop_tokens::DEFAULT_APPEARANCE;

/// The appearance the operator chose, and the one they are pointing at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppearanceChoice {
	chosen:    String,
	previewed: Option<String>,
}

impl AppearanceChoice {
	/// A choice with nothing previewed.
	#[must_use]
	pub fn new(chosen: impl Into<String>) -> Self {
		Self { chosen: chosen.into(), previewed: None }
	}

	/// The appearance a relaunch comes back in.
	#[must_use]
	pub fn chosen(&self) -> &str {
		&self.chosen
	}

	/// The appearance the pointer is resting on, absent when it rests on none.
	#[must_use]
	pub fn previewed(&self) -> Option<&str> {
		self.previewed.as_deref()
	}

	/// The appearance the window draws: the preview while there is one, and
	/// the choice otherwise.
	#[must_use]
	pub fn drawn(&self) -> &str {
		self.previewed.as_deref().unwrap_or(&self.chosen)
	}

	/// Takes the appearance under the pointer, or drops the one it left.
	pub fn preview(&mut self, appearance: Option<&str>) {
		self.previewed = appearance.map(ToString::to_string);
	}

	/// Settles on an appearance, which ends the preview: what is drawn is now
	/// what was chosen, so leaving the row reverts to nothing.
	pub fn choose(&mut self, appearance: &str) {
		self.chosen.clear();
		self.chosen.push_str(appearance);
		self.previewed = None;
	}
}

impl Default for AppearanceChoice {
	fn default() -> Self {
		Self::new(DEFAULT_APPEARANCE)
	}
}
