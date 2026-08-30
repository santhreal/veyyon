//! Everything the operator can change, and the bounds it is held to.
//!
//! Every value here has a control on a settings page, and every control there
//! is one of these: a setting with no control is a flag nobody can reach, and a
//! control with no setting is a switch that does nothing.

/// Which way the window reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Appearance {
	Dark,
	Light,
}

impl Appearance {
	pub fn flipped(self) -> Appearance {
		match self {
			Appearance::Dark => Appearance::Light,
			Appearance::Light => Appearance::Dark,
		}
	}
}

/// Everything the operator can change and the window remembers.
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
	pub appearance:      Appearance,
	pub sidebar_width:   f32,
	pub sidebar_open:    bool,
	pub group_by_folder: bool,
	pub font_size:       f32,
}

impl Default for Settings {
	fn default() -> Settings {
		Settings {
			appearance:      Appearance::Dark,
			sidebar_width:   SIDEBAR_DEFAULT,
			sidebar_open:    true,
			group_by_folder: true,
			font_size:       14.0,
		}
	}
}

/// Sidebar width bounds. A drag is clamped to these and a double click on the
/// handle returns to the default.
pub const SIDEBAR_MIN: f32 = 200.0;
pub const SIDEBAR_DEFAULT: f32 = 260.0;
pub const SIDEBAR_MAX: f32 = 400.0;

/// Text size bounds, for the appearance page's stepper.
pub const FONT_MIN: f32 = 11.0;
pub const FONT_MAX: f32 = 20.0;

/// The settings pages, in nav order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SettingsPage {
	Appearance,
	Keys,
}

impl SettingsPage {
	pub const ALL: [SettingsPage; 2] = [SettingsPage::Appearance, SettingsPage::Keys];

	pub fn label(self) -> &'static str {
		match self {
			SettingsPage::Appearance => "Appearance",
			SettingsPage::Keys => "Keyboard",
		}
	}
}
