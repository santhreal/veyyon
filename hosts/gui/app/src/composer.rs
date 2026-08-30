//! Where a message is written.
//!
//! Docked, never floating over the transcript: a field that hovers costs the
//! last line of the conversation to a drop shadow, and the last line is the one
//! being read. It sits on the same reading column as the transcript so the
//! caret is under the text it follows.
//!
//! ONE ROW. The field, and one button at its right. The keyboard hint is under
//! the field at the faintest weight in the window rather than beside the text,
//! because a hint that shares a line with the caret is read on every keystroke
//! and needed once.

use gpui::{
	Context, Div, Focusable, InteractiveElement, ParentElement, StatefulInteractiveElement, Styled,
	Window, div, prelude::FluentBuilder, px,
};

use crate::{
	input::Editor,
	motion::{self, Channel, Key},
	shell::Shell,
	state::moves,
	theme::{Theme, layout, radius, size, space},
	ui,
};

pub fn render(shell: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) -> Div {
	let theme = Theme::get(cx);
	let now = shell.now;
	let focused = shell.composer.read(cx).focus_handle(cx).is_focused(window);
	let armed = shell
		.store
		.selected_session()
		.is_some_and(|session| !session.draft.trim().is_empty());

	// The notice is a line, not a toast: a box that appears over the corner of
	// the window has to be dismissed, and this says something for four seconds
	// and then stops.
	let notice = shell.store.notice.clone();
	let showing = shell.motion.drive(
		Key::of(Channel::Notice),
		motion::FADE,
		if notice.is_some() { 1.0 } else { 0.0 },
		now,
	);

	div()
		.flex()
		.flex_col()
		.items_center()
		.w_full()
		.flex_none()
		.px(px(space::HUGE))
		.pb(px(space::LOOSE))
		.child(
			div()
				.flex()
				.flex_col()
				.gap(px(space::SNUG))
				.w_full()
				.max_w(px(layout::READING))
				.when(showing > 0.01, |element| {
					element.child(
						div()
							.h(px(16.0))
							.opacity(showing)
							.text_size(px(size::META))
							.text_color(theme.text_faint)
							.children(notice),
					)
				})
				.child(pill(shell, focused, armed, cx))
				// The hint is for the keystroke nobody has tried yet. A line
				// that stays under the caret forever is read on every
				// keystroke and needed once, so it goes as soon as there is
				// something to send.
				.when(!armed, |element| {
					element.child(
						div()
							.px(px(space::BASE))
							.text_size(px(size::META))
							.text_color(theme.text_faint)
							.child("Return to send, shift-return for a new line"),
					)
				}),
		)
}

/// The field itself, and the one button beside it.
fn pill(shell: &mut Shell, focused: bool, armed: bool, cx: &mut Context<Shell>) -> Div {
	let theme = Theme::get(cx);
	let now = shell.now;

	// The focus ring fades in rather than snapping, which is the difference
	// between a field that was focused and a field that lit up.
	let lit = shell.motion.drive(
		Key::named(Channel::Control, "composer-edge"),
		motion::FADE,
		if focused { 1.0 } else { 0.0 },
		now,
	);
	let border = motion::mix(gpui::transparent_black(), theme.ring, lit);

	let send_key = Key::named(Channel::Control, "send");
	let send_hover = shell.motion.value(send_key, now);
	let send_ground = if armed {
		motion::mix(theme.accent, theme.accent.opacity(0.82), send_hover)
	} else {
		motion::mix(gpui::transparent_black(), theme.hover(), send_hover)
	};
	let send_ink = if armed {
		theme.text_on_accent
	} else {
		theme.text_faint
	};

	div()
		.flex()
		.items_end()
		.gap(px(space::SNUG))
		.w_full()
		.p(px(space::BASE))
		.rounded(px(radius::CARD))
		.bg(theme.raised)
		.border_1()
		.border_color(border)
		// The pill is one field as far as a pointer is concerned. A press on
		// its padding or the space beside the text puts the keyboard in it
		// rather than taking the keyboard away from it.
		.on_mouse_down(
			gpui::MouseButton::Left,
			cx.listener(|shell, _, window: &mut Window, cx| {
				Editor::focus(&shell.composer, window, cx);
			}),
		)
		.child(
			div()
				.flex_1()
				.min_w(px(0.0))
				.px(px(space::SNUG))
				.child(shell.composer.clone()),
		)
		.child(
			div()
				.id("send")
				.flex()
				.items_center()
				.justify_center()
				.size(px(30.0))
				.flex_none()
				.rounded(px(radius::PILL))
				.bg(send_ground)
				.text_size(px(size::SMALL))
				.text_color(send_ink)
				.cursor_pointer()
				.on_hover(cx.listener(move |shell, hovered: &bool, window, _| {
					let now = shell.now;
					shell.motion.flip(send_key, *hovered, motion::WASH, now);
					window.refresh();
				}))
				.on_click(cx.listener(move |shell, _, window, cx| {
					if moves::send(&mut shell.store) {
						shell.composer.update(cx, |editor, cx| editor.clear(cx));
						Editor::focus(&shell.composer, window, cx);
					}
					cx.notify();
				}))
				.child(ui::glyph::SEND),
		)
}
