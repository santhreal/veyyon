//! The conversation.
//!
//! A reading column, not a full-width sprawl: prose at the window's width is
//! unreadable, and a transcript is mostly prose. The column is centred and
//! capped.
//!
//! WHAT IS IN IT. What was written in this window, and nothing else. No engine
//! is attached, so a transcript is one side of a conversation; the tail says so
//! in one line, under the last message, where a reply would be. Drawing an
//! answer nobody produced would make every other thing on screen suspect.
//!
//! A message is a filled block against the right edge. That is the one
//! asymmetry a transcript needs, and it is already correct for the day a reply
//! arrives in the column beside it.

use gpui::{
	AnyElement, Context, Div, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div, prelude::FluentBuilder, px,
};

use crate::{
	motion::{self, Channel, Key},
	shell::Shell,
	state::model::{Block, Message},
	theme::{Theme, layout, radius, size, space},
};

pub fn render(shell: &mut Shell, cx: &mut Context<Shell>) -> AnyElement {
	let theme = Theme::get(cx);
	let Some(session) = shell.store.selected_session() else {
		return empty(shell, cx).into_any_element();
	};
	if session.messages.is_empty() {
		return empty(shell, cx).into_any_element();
	}

	let messages: Vec<Message> = session.messages.clone();
	let now = shell.now;

	let mut column = div()
		.flex()
		.flex_col()
		.gap(px(space::LOOSE))
		.w_full()
		.max_w(px(layout::READING))
		.px(px(space::HUGE))
		.py(px(space::HUGE));

	for message in &messages {
		let key = Key::at(Channel::Message, message.id);
		let appearing = shell.motion.enter(key, motion::ENTER, now);
		column = column.child(
			div()
				.relative()
				.opacity(appearing)
				.top(px(8.0 * (1.0 - appearing)))
				.child(turn(shell, message, cx)),
		);
	}

	// Where a reply would be. One line, the faintest text in the window, at the
	// left of the column so it reads as the other side of the conversation.
	column = column.child(
		div()
			.text_size(px(size::SMALL))
			.text_color(theme.text_faint)
			.child("No engine attached, so nothing answers yet."),
	);

	div()
		.id("transcript")
		.flex()
		.flex_col()
		.items_center()
		.size_full()
		.overflow_y_scroll()
		.track_scroll(&shell.transcript)
		.child(column.mt_auto())
		.into_any_element()
}

/// One turn: a block against the right edge, with its fenced code as wells cut
/// into it.
fn turn(shell: &mut Shell, message: &Message, cx: &mut Context<Shell>) -> AnyElement {
	let theme = Theme::get(cx);
	// A block shrinks to its prose, except when it carries code. A well that
	// takes its width from the widest code line has no slack for the difference
	// between a measured run of mono text and a painted one, and the last glyph
	// ends up against the fill's edge; a fixed column also keeps a run of
	// answers from stepping in and out as their longest line changes.
	let has_code = message
		.blocks
		.iter()
		.any(|block| matches!(block, Block::Code { .. }));
	let width = px(layout::READING * 0.82);
	let mut bubble = div()
		.flex()
		.flex_col()
		.gap(px(space::BASE))
		.map(|element| {
			if has_code {
				element.w(width)
			} else {
				element.max_w(width)
			}
		})
		.px(px(space::WIDE))
		.py(px(space::BASE))
		.rounded(px(radius::CARD))
		.bg(theme.raised)
		.text_color(theme.text);
	for block in &message.blocks {
		bubble = bubble.child(render_block(shell, block, cx));
	}
	div()
		.flex()
		.justify_end()
		.w_full()
		.child(bubble)
		.into_any_element()
}

fn render_block(_shell: &mut Shell, block: &Block, cx: &mut Context<Shell>) -> AnyElement {
	let theme = Theme::get(cx);
	match block {
		Block::Text(text) => div().w_full().child(text.clone()).into_any_element(),

		Block::Code { lang, body } => div()
			.flex()
			.flex_col()
			.gap(px(space::TIGHT))
			.w_full()
			.px(px(space::BASE))
			.py(px(space::SNUG))
			.rounded(px(radius::CHIP))
			.bg(theme.sunken)
			.overflow_hidden()
			.when(!lang.is_empty(), |element| {
				element.child(
					div()
						.text_size(px(size::META))
						.text_color(theme.text_faint)
						.child(lang.clone()),
				)
			})
			.child(
				div()
					.font_family(theme.font_mono)
					.text_size(px(size::SMALL))
					.child(body.clone()),
			)
			.into_any_element(),
	}
}

/// An empty conversation. One line, where the first message will be, saying the
/// one thing worth knowing before writing it.
fn empty(shell: &mut Shell, cx: &mut Context<Shell>) -> Div {
	let theme = Theme::get(cx);
	let now = shell.now;
	let appearing = shell
		.motion
		.enter(Key::of(Channel::Message), motion::ENTER, now);

	div().flex().flex_col().items_center().size_full().child(
		div()
			.mt_auto()
			.w_full()
			.max_w(px(layout::READING))
			.px(px(space::HUGE))
			.pb(px(space::HUGE))
			.opacity(appearing)
			.text_size(px(size::BODY))
			.text_color(theme.text_faint)
			.child(
				"No engine is attached, so nothing answers yet. What you write stays in this window.",
			),
	)
}
