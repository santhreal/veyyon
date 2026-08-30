//! What settings shows, decided without a window.

use veyyon_gui_core::{
	command::Command,
	store::model::{Appearance, FONT_MAX, FONT_MIN, SIDEBAR_DEFAULT, Settings, SettingsPage, Store},
};
use veyyon_gui_kit::ui::Icon;

/// One entry in the nav at the left of the page.
#[derive(Debug, Clone, PartialEq)]
pub struct Nav {
	pub page:     SettingsPage,
	pub what:     &'static str,
	pub icon:     Icon,
	pub selected: bool,
	pub command:  Command,
}

/// The nav, built from the page list rather than written out here.
///
/// A page added to the model appears in the nav without this being edited,
/// which is the difference between adding a page and remembering four places.
pub fn nav(open: SettingsPage) -> Vec<Nav> {
	SettingsPage::ALL
		.into_iter()
		.map(|page| Nav {
			page,
			what: page.label(),
			icon: icon_for(page),
			selected: page == open,
			command: Command::OpenSettings(page),
		})
		.collect()
}

/// The drawing for a page. Exhaustive, so a new page has to be given one.
fn icon_for(page: SettingsPage) -> Icon {
	match page {
		SettingsPage::Appearance => Icon::Settings,
		SettingsPage::Keys => Icon::Keyboard,
	}
}

/// The two appearance choices, in the order they are drawn, with the command
/// each one runs.
///
/// Light first: it is the one a reader who has never opened this is more likely
/// to be looking for, since the window opens dark.
pub fn appearances(settings: &Settings) -> Vec<(Appearance, &'static str, Icon, bool, Command)> {
	[(Appearance::Light, "Light", Icon::Light), (Appearance::Dark, "Dark", Icon::Dark)]
		.into_iter()
		.map(|(appearance, what, icon)| {
			(
				appearance,
				what,
				icon,
				settings.appearance == appearance,
				Command::SetAppearance(appearance),
			)
		})
		.collect()
}

/// The text size, as it is printed, and whether each end of the stepper is
/// live.
///
/// The limits come from the model's own bounds, so a stepper cannot offer a
/// step the store would clamp away: a control that can be pressed and does
/// nothing is worse than one that is visibly at its end.
pub fn text_size(settings: &Settings) -> (String, bool, bool) {
	let size = settings.font_size;
	(printed(size), size > FONT_MIN, size < FONT_MAX)
}

/// A size without a trailing zero: `13.5`, and `14` rather than `14.0`.
fn printed(size: f32) -> String {
	if (size - size.round()).abs() < 0.05 {
		format!("{}", size.round() as i32)
	} else {
		format!("{size:.1}")
	}
}

/// Whether the conversation list is at the width it opens at.
///
/// The reset is offered either way; when there is nothing to reset it is drawn
/// as spent rather than hidden, since a control that comes and goes is one a
/// reader has to hunt for twice.
pub fn sidebar_at_default(settings: &Settings) -> bool {
	(settings.sidebar_width - SIDEBAR_DEFAULT).abs() < 0.5
}

/// The width, as it is printed.
pub fn sidebar_width(settings: &Settings) -> String {
	format!("{} px", settings.sidebar_width.round() as i32)
}

/// Whether the conversation list is grouped by checkout.
pub fn grouped(store: &Store) -> bool {
	store.settings.group_by_folder
}
