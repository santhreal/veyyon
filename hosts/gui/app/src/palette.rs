//! One overlay over one list.
//!
//! Conversations and commands, one sheet, one keyboard path. A separate picker
//! per list is a second place for the arrow keys to behave differently.
//!
//! IT LEAVES AS FAST AS IT ARRIVES, AND NO FASTER. Coming in takes 180ms with a
//! rise, because it is asking to be read; going out takes 110ms with none,
//! because it has been read and the window behind it is the answer. The sheet
//! stays mounted while the channel is above zero, so the closing frames are
//! drawn rather than cut.
//!
//! The cursor clamps at both ends. A list that wraps under a held arrow key
//! never settles anywhere.

use gpui::{
	AnyElement, Context, Div, InteractiveElement, IntoElement, MouseButton, ParentElement, Stateful,
	StatefulInteractiveElement, Styled, div, prelude::FluentBuilder, px,
};

use crate::{
	input::Editor,
	motion::{self, Channel, Key},
	shell::Shell,
	state::{model::PaletteRow, moves},
	theme::{Theme, layout, radius, size, space},
	ui,
};

pub fn render(shell: &mut Shell, cx: &mut Context<Shell>) -> Option<AnyElement> {
	let theme = Theme::get(cx);
	let now = shell.now;
	let open = shell.store.overlay.is_open();
	let key = Key::of(Channel::Sheet);
	let spec = if open {
		motion::SHEET_IN
	} else {
		motion::SHEET_OUT
	};
	let showing = shell
		.motion
		.drive(key, spec, if open { 1.0 } else { 0.0 }, now);
	if showing <= 0.001 {
		return None;
	}

	let selected = shell
		.store
		.overlay
		.palette()
		.map_or(0, |palette| palette.selected);
	let rows = moves::palette_rows(&shell.store);

	let mut list = div()
		.id("palette-rows")
		.flex()
		.flex_col()
		.max_h(px(360.0))
		.overflow_y_scroll()
		.p(px(space::SNUG));
	if rows.is_empty() {
		list = list.child(
			div()
				.px(px(space::WIDE))
				.py(px(space::BASE))
				.text_size(px(size::SMALL))
				.text_color(theme.text_faint)
				.child("Nothing matches"),
		);
	}
	for (index, row) in rows.iter().enumerate() {
		list = list.child(entry(shell, index, row, index == selected, cx));
	}

	Some(
		div()
			.absolute()
			.inset_0()
			.flex()
			.flex_col()
			.items_center()
			// The window behind the sheet is dimmed rather than blurred: a blur
			// costs a full-window pass every frame of the fade, and dimming is
			// what says the sheet has the keyboard.
			.bg(gpui::black().opacity(0.45 * showing))
			.on_mouse_down(
				MouseButton::Left,
				cx.listener(|shell, _, window, cx| {
					moves::close_overlay(&mut shell.store);
					Editor::focus(&shell.composer, window, cx);
					cx.notify();
				}),
			)
			.child(
				div()
					.relative()
					.top(px(116.0 - 10.0 * showing))
					.w(px(layout::SHEET))
					.opacity(showing)
					.flex()
					.flex_col()
					.rounded(px(radius::SHEET))
					.bg(theme.overlay)
					.border_1()
					.border_color(theme.stroke)
					.shadow_lg()
					.overflow_hidden()
					.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
					.child(
						ui::line_of(space::BASE)
							.px(px(space::WIDE))
							.h(px(50.0))
							.child(
								div()
									.flex_none()
									.text_size(px(size::SMALL))
									.text_color(theme.text_faint)
									.child(ui::glyph::SEARCH),
							)
							.child(div().flex_1().min_w(px(0.0)).child(shell.search.clone())),
					)
					.child(ui::hairline(&theme))
					.child(list),
			)
			.into_any_element(),
	)
}

/// One row of the sheet.
fn entry(
	shell: &mut Shell,
	index: usize,
	row: &PaletteRow,
	selected: bool,
	cx: &mut Context<Shell>,
) -> Stateful<Div> {
	let theme = Theme::get(cx);
	let now = shell.now;
	let key = Key::at(Channel::Row, index as u64 + 1);
	let hover = shell.motion.value(key, now);
	// The cursor is the keyboard's and the wash is the pointer's, so a row can
	// be both and reads as one.
	let ground = if selected {
		theme.selected()
	} else {
		motion::mix(gpui::transparent_black(), theme.hover(), hover)
	};

	div()
		.id(gpui::ElementId::Name(format!("palette-{index}").into()))
		.flex()
		.items_center()
		.gap(px(space::BASE))
		.h(px(36.0))
		.px(px(space::WIDE))
		.rounded(px(radius::ROW))
		.bg(ground)
		.cursor_pointer()
		.on_hover(cx.listener(move |shell, hovered: &bool, window, _| {
			let now = shell.now;
			shell.motion.flip(key, *hovered, motion::WASH, now);
			window.refresh();
		}))
		.on_click(cx.listener(move |shell, _, _, cx| {
			// Clicking moves the cursor and then takes it, so a click and a
			// return key go through one accept.
			let at = shell
				.store
				.overlay
				.palette()
				.map_or(0, |palette| palette.selected);
			moves::palette_move(&mut shell.store, index as isize - at as isize);
			moves::palette_accept(&mut shell.store);
			Theme::set(shell.store.settings.appearance, cx);
			shell.show_selected(cx);
			cx.notify();
		}))
		.child(
			ui::line(row.label.clone())
				.flex_1()
				.min_w(px(0.0))
				.text_size(px(size::SMALL))
				.text_color(theme.text),
		)
		.when(!row.detail.is_empty(), |element| {
			element.child(
				div()
					.flex_none()
					.text_size(px(size::META))
					.text_color(theme.text_faint)
					.child(row.detail.clone()),
			)
		})
		.when(row.current, |element| {
			element.child(
				div()
					.flex_none()
					.text_size(px(size::META))
					.text_color(theme.accent)
					.child(ui::glyph::CHECK),
			)
		})
}
