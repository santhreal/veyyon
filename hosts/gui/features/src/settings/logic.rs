//! What settings shows, decided without a window.

use veyyon_gui_core::{
	command::Command,
	store::model::{
		Appearance, FONT_MAX, FONT_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, Settings,
		SettingsPage, Store,
	},
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

/// A number a stepper drives: what it reads as, and what each end does.
///
/// An end at its bound is `None`, so the control draws that end spent rather
/// than offering a press the store would clamp away: a control that can be
/// pressed and does nothing is worse than one that is visibly at its end.
#[derive(Debug, Clone, PartialEq)]
pub struct Steps {
	pub printed: String,
	pub less:    Option<Command>,
	pub more:    Option<Command>,
}

/// How much of the list's width one press moves.
///
/// The whole range is ten presses, which is a control somebody can walk to
/// either end of without holding a button down.
const SIDEBAR_STEP: f32 = 20.0;

/// The text size, and the step either side of it.
pub fn text_size(settings: &Settings) -> Steps {
	let size = settings.font_size;
	Steps {
		printed: printed(size),
		less:    (size > FONT_MIN).then_some(Command::StepTextSize { up: false }),
		more:    (size < FONT_MAX).then_some(Command::StepTextSize { up: true }),
	}
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

/// The list's width, and the step either side of it.
///
/// The width is also set by dragging the edge of the column, so the two ways
/// of setting it go through the same command and the same clamp.
pub fn sidebar_width(settings: &Settings) -> Steps {
	let width = settings.sidebar_width;
	Steps {
		printed: printed(width),
		less:    (width > SIDEBAR_MIN).then_some(Command::SetSidebarWidth(width - SIDEBAR_STEP)),
		more:    (width < SIDEBAR_MAX).then_some(Command::SetSidebarWidth(width + SIDEBAR_STEP)),
	}
}

/// Whether the conversation list is grouped by checkout.
pub fn grouped(store: &Store) -> bool {
	store.settings.group_by_folder
}
