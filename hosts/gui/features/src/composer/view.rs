//! Drawing the field, and the two lines around it.

use gpui::{
	App, Div, Entity, InteractiveElement, MouseButton, ParentElement, Styled, Window, div, px,
	transparent_black,
};
use veyyon_gui_core::{command::Command, store::model::Store};
use veyyon_gui_kit::{
	input::Editor,
	motion::{self, Channel, Key, mix},
	paint,
	theme::{Theme, layout, radius, size, space},
	ui::{Button, Fill, Icon, Tone, kbd, text},
};

use super::logic;
use crate::act;

/// The composer: notice, field, hint.
pub fn render(store: &Store, field: &Entity<Editor>, window: &mut Window, cx: &mut App) -> Div {
	let armed = logic::armed(store);
	let focused = Editor::holds_keyboard(field, window, cx);

	div()
		.flex()
		.flex_col()
		.items_center()
		.w_full()
		.flex_none()
		.px(px(space::HUGE))
		.pb(px(space::LOOSE))
		.child(
			text::stack(space::SNUG)
				.w_full()
				.max_w(px(layout::READING))
				.children(notice(store, cx))
				.child(pill(field, armed, focused, cx))
				// The hint is for the keystroke nobody has tried yet, so it fades
				// as soon as there is something to send: a line that stays under
				// the caret forever is read on every keystroke and needed once.
				// Its row keeps its height while it goes, because a field that
				// steps down the window on the first character is a field that
				// moved while somebody was aiming at it.
				.child(hint(cx).opacity(paint::toward(
					cx,
					Key::named(Channel::Control, "composer-hint"),
					motion::FADE,
					f32::from(!armed),
				))),
		)
}

/// The field, and the one control beside it.
fn pill(field: &Entity<Editor>, armed: bool, focused: bool, cx: &mut App) -> Div {
	let theme = Theme::get(cx);

	// The ring fades in rather than snapping, which is the difference between a
	// field that was focused and a field that lit up.
	let lit = paint::toward(
		cx,
		Key::named(Channel::Control, "composer-edge"),
		motion::FADE,
		if focused { 1.0 } else { 0.0 },
	);
	let field = field.clone();

	div()
		.flex()
		.items_end()
		.gap(px(space::SNUG))
		.w_full()
		.p(px(space::BASE))
		.rounded(px(radius::CARD))
		.bg(theme.raised)
		.border_1()
		.border_color(mix(transparent_black(), theme.ring, lit))
		// The pill is one field as far as a pointer is concerned: a press on its
		// padding, or on the space beside the text, puts the keyboard in it
		// rather than taking the keyboard away from it.
		.on_mouse_down(MouseButton::Left, {
			let field = field.clone();
			move |_, window: &mut Window, cx: &mut App| Editor::focus(&field, window, cx)
		})
		.child(
			div()
				.flex_1()
				.min_w(px(0.0))
				.px(px(space::SNUG))
				.child(field),
		)
		.child(
			// Solid only once there is something to send. A lit control over an
			// empty field is a promise the press does not keep.
			Button::new("send", Icon::Send)
				.tone(Tone::Accent)
				.fill(if armed { Fill::Solid } else { Fill::Ghost })
				.enabled(armed)
				.tip("Send")
				.keys("enter")
				.on_click(act::click(Command::Send)),
		)
}

/// The notice line: what the store had to say, for as long as it says it.
fn notice(store: &Store, cx: &mut App) -> Option<Div> {
	let theme = Theme::get(cx);
	let notice = logic::notice(store).map(str::to_owned);
	let showing =
		paint::toward(cx, Key::of(Channel::Notice), motion::FADE, f32::from(notice.is_some()));
	if showing <= 0.01 {
		return None;
	}
	Some(
		div()
			.flex()
			.items_center()
			.gap(px(space::SNUG))
			.h(px(18.0))
			.px(px(space::SNUG))
			.opacity(showing)
			.child(veyyon_gui_kit::ui::icon::at(
				Icon::Notice,
				veyyon_gui_kit::ui::icon::scale::SMALL,
				theme.text_faint,
			))
			.children(notice.map(|notice| text::meta(notice, &theme))),
	)
}

/// The two keystrokes, drawn as keys rather than described in prose.
///
/// A chord and what it does are one thing, so the gap inside a hint is smaller
/// than the gap between two hints: with one gap for both, four caps and two
/// phrases read as six unrelated items. The row starts where the field's text
/// starts, which is the pill's border, its padding and the field's own inset.
fn hint(cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let mut line = div()
		.flex()
		.items_center()
		.gap(px(space::LOOSE))
		.px(px(space::BASE + space::SNUG + 1.0))
		.flex_wrap();
	for (keys, what) in logic::hints() {
		line = line.child(
			div()
				.flex()
				.items_center()
				.gap(px(space::SNUG))
				.child(kbd::caps(keys, &theme))
				.child(
					div()
						.text_size(px(size::META))
						.text_color(theme.text_faint)
						.child(what),
				),
		);
	}
	line
}
