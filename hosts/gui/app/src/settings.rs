//! Settings, in the main panel rather than in a dialog.
//!
//! A dialog would float over the conversation it is changing the look of, which
//! is the one thing a look setting has to be judged against. Here the sidebar
//! and the header stay on screen and change under the pointer as a value is
//! set.
//!
//! Every control on these pages is wired to a move over the store. A page that
//! shows a switch which changes nothing is worse than a page that does not show
//! it, so there is a page per thing this window can actually change and no page
//! for anything an engine would own.

use gpui::{
	Context, Div, InteractiveElement, IntoElement, ParentElement, Stateful,
	StatefulInteractiveElement, Styled, div, px,
};

use crate::{
	motion::{self, Channel, Key},
	shell::Shell,
	state::{
		model::{Appearance, SettingsPage},
		moves,
	},
	theme::{Theme, layout, radius, size, space},
	ui,
};

pub fn render(shell: &mut Shell, page: SettingsPage, cx: &mut Context<Shell>) -> Stateful<Div> {
	let body = match page {
		SettingsPage::Appearance => appearance(shell, cx).into_any_element(),
		SettingsPage::Keys => keyboard(cx).into_any_element(),
	};

	div()
		.id("settings-body")
		.flex()
		.flex_col()
		.items_center()
		.size_full()
		.min_h(px(0.0))
		.overflow_y_scroll()
		.child(
			div()
				.flex()
				.flex_col()
				.gap(px(space::LOOSE))
				.w_full()
				.max_w(px(layout::READING))
				.px(px(space::HUGE))
				.py(px(space::LOOSE))
				.child(nav(shell, page, cx))
				.child(body),
		)
}

/// The page picker: two pills, not a second sidebar. A navigation column for
/// two entries is a column of whitespace.
fn nav(shell: &mut Shell, current: SettingsPage, cx: &mut Context<Shell>) -> Div {
	let mut row = ui::line_of(space::SNUG).flex_none();
	for page in SettingsPage::ALL {
		row = row.child(segment(shell, page.label(), page.label(), page == current, cx).on_click(
			cx.listener(move |shell, _, _, cx| {
				moves::open_settings(&mut shell.store, page);
				cx.notify();
			}),
		));
	}
	row
}

fn appearance(shell: &mut Shell, cx: &mut Context<Shell>) -> Div {
	let theme = Theme::get(cx);
	let current = shell.store.settings.appearance;
	let font_size = shell.store.settings.font_size;
	let grouped = shell.store.settings.group_by_folder;

	page(&theme)
		.child(
			field(&theme, "Appearance", "Dark grounds, or light ones.").child(
				ui::line_of(space::SNUG)
					.child(segment(shell, "dark", "Dark", current == Appearance::Dark, cx).on_click(
						cx.listener(|shell, _, _, cx| {
							moves::set_appearance(&mut shell.store, Appearance::Dark);
							Theme::set(Appearance::Dark, cx);
							cx.notify();
						}),
					))
					.child(segment(shell, "light", "Light", current == Appearance::Light, cx).on_click(
						cx.listener(|shell, _, _, cx| {
							moves::set_appearance(&mut shell.store, Appearance::Light);
							Theme::set(Appearance::Light, cx);
							cx.notify();
						}),
					)),
			),
		)
		.child(
			field(&theme, "Text size", "Applies to the whole window.").child(
				ui::line_of(space::SNUG)
					.child(step(shell, "font-down", "\u{2212}", cx).on_click(cx.listener(
						|shell, _, _, cx| {
							let next = shell.store.settings.font_size - 1.0;
							moves::set_font_size(&mut shell.store, next);
							cx.notify();
						},
					)))
					.child(
						div()
							.w(px(28.0))
							.text_size(px(size::SMALL))
							.text_color(theme.text)
							.child(format!("{font_size:.0}")),
					)
					.child(step(shell, "font-up", "+", cx).on_click(cx.listener(|shell, _, _, cx| {
						let next = shell.store.settings.font_size + 1.0;
						moves::set_font_size(&mut shell.store, next);
						cx.notify();
					}))),
			),
		)
		.child(
			field(&theme, "Group by checkout", "A heading per folder in the conversation list.")
				.child(switch(shell, "grouped", grouped, cx).on_click(cx.listener(
					|shell, _, _, cx| {
						moves::toggle_group_by_folder(&mut shell.store);
						cx.notify();
					},
				))),
		)
}

fn keyboard(cx: &mut Context<Shell>) -> Div {
	let theme = Theme::get(cx);
	let mut rows = page(&theme);
	for (keys, what) in crate::keys::documented() {
		rows = rows.child(
			ui::line_of(space::WIDE)
				.w_full()
				.px(px(space::WIDE))
				.py(px(space::SNUG))
				.child(
					// Wide enough for the longest keystroke this table can
					// produce, spelled in words: a keystroke that wraps takes
					// its row out of step with every other one.
					div()
						.w(px(170.0))
						.flex_none()
						.whitespace_nowrap()
						.font_family(theme.font_mono)
						.text_size(px(size::SMALL))
						.text_color(theme.text)
						.child(keys),
				)
				.child(
					div()
						.flex_1()
						.min_w(px(0.0))
						.text_size(px(size::SMALL))
						.text_color(theme.text_muted)
						.child(what),
				),
		);
	}
	rows
}

// ---- the pieces a page is built from ----

/// A page's column: one card, so a page reads as one surface rather than as a
/// stack of framed rows with a line between each.
fn page(theme: &Theme) -> Div {
	div()
		.flex()
		.flex_col()
		.w_full()
		.p(px(space::SNUG))
		.rounded(px(radius::CARD))
		.bg(theme.raised)
}

/// A labelled row with its control on the right.
fn field(theme: &Theme, label: &'static str, detail: &'static str) -> Div {
	div()
		.flex()
		.items_center()
		.gap(px(space::WIDE))
		.w_full()
		.px(px(space::WIDE))
		.py(px(space::WIDE))
		.rounded(px(radius::CARD))
		.child(
			div()
				.flex()
				.flex_col()
				.flex_1()
				.min_w(px(0.0))
				.child(
					div()
						.text_size(px(size::BODY))
						.text_color(theme.text)
						.child(label),
				)
				.child(
					div()
						.text_size(px(size::META))
						.text_color(theme.text_faint)
						.child(detail),
				),
		)
}

/// One choice in a row of them.
fn segment(
	shell: &mut Shell,
	id: &'static str,
	label: &'static str,
	selected: bool,
	cx: &mut Context<Shell>,
) -> Stateful<Div> {
	let theme = Theme::get(cx);
	let now = shell.now;
	let key = Key::named(Channel::Control, id);
	let hover = shell.motion.value(key, now);
	let ground = if selected {
		theme.accent.opacity(0.16)
	} else {
		motion::mix(theme.sunken, theme.hover(), hover)
	};
	div()
		.id(id)
		.flex()
		.items_center()
		.h(px(30.0))
		.px(px(space::WIDE))
		.rounded(px(radius::PILL))
		.bg(ground)
		.text_size(px(size::SMALL))
		.text_color(if selected {
			theme.text
		} else {
			theme.text_muted
		})
		.cursor_pointer()
		.on_hover(cx.listener(move |shell, hovered: &bool, window, _| {
			let now = shell.now;
			shell.motion.flip(key, *hovered, motion::WASH, now);
			window.refresh();
		}))
		.child(label)
}

/// A two-state switch. The knob glides rather than jumping, because the glide
/// is what says which way it went.
fn switch(shell: &mut Shell, id: &'static str, on: bool, cx: &mut Context<Shell>) -> Stateful<Div> {
	let theme = Theme::get(cx);
	let now = shell.now;
	let key = Key::named(Channel::Control, id);
	let travel = shell
		.motion
		.drive(key, motion::GLIDE, if on { 1.0 } else { 0.0 }, now);
	let track = motion::mix(theme.sunken, theme.accent, travel);
	div()
		.id(id)
		.relative()
		.flex_none()
		.w(px(40.0))
		.h(px(24.0))
		.rounded(px(radius::PILL))
		.bg(track)
		.cursor_pointer()
		.child(
			div()
				.absolute()
				.top(px(3.0))
				.left(px(3.0 + 16.0 * travel))
				.size(px(18.0))
				.rounded(px(radius::PILL))
				.bg(if on {
					theme.text_on_accent
				} else {
					theme.text_faint
				}),
		)
}

/// A round control: the text-size steppers.
fn step(
	shell: &mut Shell,
	id: &'static str,
	glyph: &'static str,
	cx: &mut Context<Shell>,
) -> Stateful<Div> {
	let theme = Theme::get(cx);
	let now = shell.now;
	let key = Key::named(Channel::Control, id);
	let ground = ui::wash(&mut shell.motion, key, theme.sunken, theme.hover(), now);
	div()
		.id(id)
		.flex()
		.items_center()
		.justify_center()
		.size(px(28.0))
		.flex_none()
		.rounded(px(radius::PILL))
		.bg(ground)
		.text_size(px(size::SMALL))
		.text_color(theme.text_muted)
		.cursor_pointer()
		.on_hover(cx.listener(move |shell, hovered: &bool, window, _| {
			let now = shell.now;
			shell.motion.flip(key, *hovered, motion::WASH, now);
			window.refresh();
		}))
		.child(glyph)
}
