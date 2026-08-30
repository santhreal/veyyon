//! Drawing the page: the nav at the left, the settings at the right.

use gpui::{
	App, Div, InteractiveElement, ParentElement, ScrollHandle, SharedString,
	StatefulInteractiveElement, Styled, div, px,
};
use veyyon_gui_core::{
	command::Command,
	store::model::{SettingsPage, Store},
};
use veyyon_gui_kit::{
	theme::{Theme, layout, space},
	ui::{Button, Field, Fill, Group, Icon, Row, Size, Stepper, Switch, Tab, Tabs, Tone, text},
};

use super::{keyboard, logic};
use crate::act;

/// How wide the nav is. Two rows of text and one button, so it is the words
/// that set it.
const NAV: f32 = 200.0;

/// The whole page.
pub fn render(store: &Store, page: SettingsPage, scroll: &ScrollHandle, cx: &mut App) -> Div {
	div()
		.flex()
		.size_full()
		.min_h(px(0.0))
		.child(nav(page, cx))
		.child(
			// Left against the nav rather than centred in what is left of the
			// window: a page whose rows drift towards the middle of a wide window
			// leaves the nav pointing at nothing.
			div()
				.id("settings-page")
				.flex()
				.flex_col()
				.items_start()
				.flex_1()
				.min_w(px(0.0))
				.overflow_y_scroll()
				.track_scroll(scroll)
				.child(
					text::stack(space::LOOSE)
						.w_full()
						.max_w(px(layout::READING))
						.px(px(space::HUGE))
						.py(px(space::HUGE))
						.child(match page {
							SettingsPage::Appearance => appearance(store, cx),
							SettingsPage::Keys => keyboard::render(cx),
						}),
				),
		)
}

/// The nav. One row per page, built from the page list.
///
/// No heading over it. The header above the column already names what this is,
/// and a word repeated a finger's width below it is read as a second thing.
fn nav(page: SettingsPage, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let mut column = text::stack(space::ROWS)
		.flex_none()
		.w(px(NAV))
		.h_full()
		.border_r_1()
		.border_color(theme.stroke)
		.px(px(space::SNUG))
		.py(px(space::BASE));

	for entry in logic::nav(page) {
		column = column.child(
			Row::new(SharedString::from(format!("settings-nav-{}", entry.what)), entry.what)
				.icon(entry.icon)
				.active(entry.selected)
				.tone(if entry.selected {
					Tone::Plain
				} else {
					Tone::Muted
				})
				.on_click(act::click(entry.command)),
		);
	}

	// The way out is where it can be pressed without reading: at the bottom of
	// the nav, under the pages, rather than as a cross floating over a corner.
	// Two words, because the column is as wide as its rows and a label that
	// does not fit is a label that ends in an ellipsis.
	column.child(text::spacer()).child(
		// A flex wrapper, so the button keeps its own width instead of being
		// stretched to the column and centring its words in it. Stretched, it
		// reads as a stray centred label under a left-aligned list.
		div().flex().child(
			Button::labelled("leave-settings", "Close settings")
				.icon(Icon::Close)
				.fill(Fill::Ghost)
				.tone(Tone::Muted)
				.keys("escape")
				.on_click(act::click(Command::CloseSettings)),
		),
	)
}

/// The appearance page.
fn appearance(store: &Store, cx: &mut App) -> Div {
	let settings = &store.settings;

	// One track with the choices in it, rather than two buttons that happen to
	// be next to each other: a pair of controls where exactly one is on is a
	// segmented control on every platform, and drawn as two buttons it reads as
	// two things to press.
	let mut appearances = Tabs::new("appearance");
	for (_, what, icon, chosen, command) in logic::appearances(settings) {
		appearances = appearances.tab(
			Tab::new(what, chosen)
				.icon(icon)
				.on_click(act::click(command)),
		);
	}

	text::stack(space::LOOSE)
		.w_full()
		.child(
			Group::new("Window")
				.child(
					Field::new("Light or dark")
						.note("Follows nothing else: this is the window's own setting.")
						.child(appearances),
				)
				.child(
					Field::new("Text size")
						.note("The size prose is drawn at. Controls scale with it.")
						.child(stepper("text-size", "px", logic::text_size(settings))),
				),
		)
		.child(
			Group::new("Conversations")
				.child(
					Field::new("Group by checkout")
						.note("Puts each checkout's conversations under its name.")
						.child(
							Switch::new("group-by-folder", logic::grouped(store))
								.on_click(act::click(Command::ToggleGroupByFolder)),
						),
				)
				.child(
					Field::new("List width")
						.note("How wide the conversation list is. Its edge drags to the same widths.")
						.child(
							Button::labelled("reset-sidebar", "Reset")
								.fill(Fill::Ghost)
								.tone(Tone::Muted)
								.size(Size::Small)
								.enabled(!logic::sidebar_at_default(settings))
								.on_click(act::click(Command::ResetSidebarWidth)),
						)
						.child(stepper("sidebar-width", "px", logic::sidebar_width(settings))),
				),
		)
		.child(hidden(cx))
}

/// A number with a step either side, wired to whatever the steps are.
fn stepper(id: &'static str, unit: &'static str, steps: logic::Steps) -> Stepper {
	let mut stepper = Stepper::new(id, steps.printed)
		.unit(unit)
		.limits(steps.less.is_some(), steps.more.is_some());
	if let Some(command) = steps.less {
		stepper = stepper.on_down(act::click(command));
	}
	if let Some(command) = steps.more {
		stepper = stepper.on_up(act::click(command));
	}
	stepper
}

/// The one thing this page says about itself: where the rest of the settings
/// are.
///
/// Not a group of empty controls. A settings page that lists knobs for things
/// that do not exist yet is a page that has to be read twice, once to find out
/// which half is real.
fn hidden(cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	div().px(px(space::WIDE)).child(text::note_wrapping(
		"Engine, model and tool settings appear here once an engine is attached.",
		&theme,
	))
}
