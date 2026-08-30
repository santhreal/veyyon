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
	theme::{layout, space},
	ui::{Button, Field, Fill, Group, Icon, Row, Size, Stepper, Switch, Tone, text},
};

use super::{keyboard, logic};
use crate::act;

/// How wide the nav is. Two rows of text, so it is the words that set it.
const NAV: f32 = 184.0;

/// The whole page.
pub fn render(store: &Store, page: SettingsPage, scroll: &ScrollHandle, cx: &mut App) -> Div {
	div()
		.flex()
		.size_full()
		.min_h(px(0.0))
		.child(nav(page, cx))
		.child(
			div()
				.id("settings-page")
				.flex()
				.flex_col()
				.items_center()
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
fn nav(page: SettingsPage, cx: &mut App) -> Div {
	let theme = veyyon_gui_kit::theme::Theme::get(cx);
	let mut column = text::stack(2.0)
		.flex_none()
		.w(px(NAV))
		.h_full()
		.border_r_1()
		.border_color(theme.stroke)
		.px(px(space::SNUG))
		.py(px(space::BASE));

	column = column.child(
		div()
			.px(px(space::BASE))
			.pb(px(space::SNUG))
			.child(text::overline("Settings", &theme)),
	);
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
	column.child(text::spacer()).child(
		div().px(px(space::TIGHT)).child(
			Button::labelled("leave-settings", "Back to the conversation")
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
	let (size, can_shrink, can_grow) = logic::text_size(settings);

	let mut choices = div().flex().items_center().gap(px(space::TIGHT));
	for (_, what, icon, chosen, command) in logic::appearances(settings) {
		choices = choices.child(
			Button::labelled(SharedString::from(format!("appearance-{what}")), what)
				.icon(icon)
				.fill(if chosen { Fill::Tinted } else { Fill::Ghost })
				.tone(if chosen { Tone::Accent } else { Tone::Muted })
				.on(chosen)
				.on_click(act::click(command)),
		);
	}

	text::stack(space::LOOSE)
		.w_full()
		.child(
			Group::new("Appearance")
				.child(
					Field::new("Light or dark")
						.note("Follows nothing else: this is the window's own setting.")
						.child(choices),
				)
				.child(
					Field::new("Text size")
						.note("The size prose is drawn at. Controls scale with it.")
						.child(
							Stepper::new("text-size", size)
								.unit("px")
								.limits(can_shrink, can_grow)
								.on_down(act::click(Command::StepTextSize { up: false }))
								.on_up(act::click(Command::StepTextSize { up: true })),
						),
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
					Field::new("Conversation list width")
						.note(logic::sidebar_width(settings))
						.child(
							Button::labelled("reset-sidebar", "Reset")
								.fill(Fill::Ghost)
								.tone(Tone::Muted)
								.size(Size::Small)
								.enabled(!logic::sidebar_at_default(settings))
								.on_click(act::click(Command::ResetSidebarWidth)),
						),
				),
		)
		.child(hidden(cx))
}

/// The one thing this page says about itself: where the rest of the settings
/// are.
///
/// Not a group of empty controls. A settings page that lists knobs for things
/// that do not exist yet is a page that has to be read twice, once to find out
/// which half is real.
fn hidden(cx: &mut App) -> Div {
	let theme = veyyon_gui_kit::theme::Theme::get(cx);
	div().px(px(space::WIDE)).child(text::note_wrapping(
		"Engine, model and tool settings appear here once an engine is attached.",
		&theme,
	))
}
