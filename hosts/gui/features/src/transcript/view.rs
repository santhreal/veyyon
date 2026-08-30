//! Drawing the column.

use gpui::{
	AnyElement, App, Div, InteractiveElement, IntoElement, ParentElement, ScrollHandle,
	StatefulInteractiveElement, Styled, div, px,
};
use veyyon_gui_core::store::model::{Message, Store};
use veyyon_gui_kit::{
	motion::{self, Channel, Key},
	paint,
	theme::{Theme, layout, size, space},
	ui::{Empty, Icon, Size, Spinner, icon, square, text},
};

use super::logic;
use crate::render::message;

/// The conversation, in its own scroll.
///
/// The scroll handle belongs to the window, which is the only part of this that
/// has to outlive a frame: a send scrolls to the latest message, and that is
/// the window carrying out a command's outcome rather than this surface
/// reacting.
pub fn render(store: &Store, scroll: &ScrollHandle, cx: &mut App) -> AnyElement {
	let messages: &[Message] = store
		.selected_session()
		.map(|session| session.messages.as_slice())
		.unwrap_or_default();

	let inner = if messages.is_empty() {
		opening(store, cx)
	} else {
		conversation(store, messages, cx)
	};

	div()
		.id("transcript")
		.relative()
		.flex()
		.flex_col()
		.items_center()
		.size_full()
		.overflow_y_scroll()
		.track_scroll(scroll)
		// A short conversation sits at the bottom, against the composer, rather
		// than at the top of a screen of nothing. Once it is longer than the
		// window this has no effect at all.
		.child(inner.mt_auto())
		.into_any_element()
}

/// The messages, and the line under them.
fn conversation(store: &Store, messages: &[Message], cx: &mut App) -> Div {
	let mut column = column();
	for message in messages {
		// Each message arrives once, keyed by its own id, so a new one rises
		// into place and the ones above it do not move.
		let arriving = paint::arriving(cx, Key::at(Channel::Message, message.id), motion::ENTER);
		column = column.child(
			div()
				.relative()
				.opacity(arriving)
				.top(px(8.0 * (1.0 - arriving)))
				.child(message::turn(message, cx)),
		);
	}
	match tail(store, messages, cx) {
		Some(line) => column.child(line),
		None => column,
	}
}

/// The reading column every message is drawn into.
fn column() -> Div {
	text::stack(space::LOOSE)
		.w_full()
		.max_w(px(layout::READING + space::HUGE * 2.0))
		.px(px(space::HUGE))
		.py(px(space::HUGE))
}

/// The line where a reply would be.
fn tail(store: &Store, messages: &[Message], cx: &mut App) -> Option<AnyElement> {
	let theme = Theme::get(cx);
	let tail = logic::tail(store, messages);
	let what = tail.what()?.to_owned();

	// The line stands in the same gutter the engine's own messages use, so it
	// reads as the other side of the conversation rather than as a status bar
	// that happens to be at the bottom of the scroll.
	Some(
		div()
			.flex()
			.items_center()
			.gap(px(space::BASE))
			.w_full()
			.child(if tail.turning() {
				Spinner::new("tail").size(Size::Small).into_any_element()
			} else {
				square(icon::scale::SMALL)
					.child(icon::at(Icon::Engine, icon::scale::SMALL, theme.text_faint))
					.into_any_element()
			})
			.child(
				div()
					.text_size(px(size::SMALL))
					.text_color(theme.text_faint)
					.child(what),
			)
			.into_any_element(),
	)
}

/// A conversation with nothing in it yet.
fn opening(store: &Store, cx: &mut App) -> Div {
	let opening = logic::opening(store);
	let arriving = paint::arriving(cx, Key::of(Channel::Message), motion::ENTER);

	// Above the composer rather than centred in the window: the first thing
	// written goes under this line, and an empty state in the middle of the
	// screen moves the moment it stops being empty.
	column().opacity(arriving).child(
		Empty::new(opening.what)
			.note(opening.note)
			.icon(Icon::Engine),
	)
}
