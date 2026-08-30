//! The conversation.
//!
//! A reading column, not a full-width sprawl: prose at the window's width is
//! unreadable, and a transcript is mostly prose. The column is centred and
//! capped, and the pieces that are not prose (a diff, a terminal's output) are
//! allowed the full column because they are read by scanning rather than by
//! line.
//!
//! WHO SAID IT. A turn from the operator is a filled block against the right
//! edge; a reply is prose in the column with no container at all. That is the
//! one asymmetry that lets a long transcript be skimmed: the eye finds the
//! right edge and reads down it for the questions.
//!
//! STREAMING. A reply arriving is the same drawing as a reply that arrived. The
//! blocks are appended by `moves::tick`, so nothing here knows whether the text
//! came from a socket or from the local responder, and the autoscroll cannot
//! tell either.

use gpui::{
	AnyElement, Context, Div, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div, prelude::FluentBuilder, px,
};

use crate::{
	motion::{self, Channel, Key},
	shell::Shell,
	state::model::{Block, Message, Role, ToolState},
	theme::{Theme, layout, radius, size, space},
	ui,
};

pub fn render(shell: &mut Shell, cx: &mut Context<Shell>) -> AnyElement {
	let theme = Theme::get(cx);
	let Some(session) = shell.store.selected_session() else {
		return empty(shell, cx).into_any_element();
	};

	let messages: Vec<Message> = session.messages.clone();
	let streaming = session.run.is_some();
	let now = shell.now;

	// Pinned to the bottom unless the reader has scrolled away from it. A
	// transcript that yanks itself down while somebody is reading further up is
	// worse than one that does not follow at all.
	let offset = shell.transcript.offset().y;
	let max = shell.transcript.max_offset().y;
	let pinned = f32::from(max + offset).abs() < 48.0;
	if streaming && pinned {
		shell.transcript.scroll_to_bottom();
	}

	let mut column = div()
		.flex()
		.flex_col()
		.gap(px(space::HUGE))
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

	div()
		.id("transcript")
		.flex()
		.flex_col()
		.items_center()
		.size_full()
		.overflow_y_scroll()
		.track_scroll(&shell.transcript)
		.bg(theme.canvas)
		.child(column)
		.into_any_element()
}

/// One turn.
fn turn(shell: &mut Shell, message: &Message, cx: &mut Context<Shell>) -> AnyElement {
	let theme = Theme::get(cx);
	match message.role {
		Role::User => div()
			.flex()
			.justify_end()
			.w_full()
			.child(
				div()
					.max_w(px(layout::READING * 0.78))
					.px(px(space::WIDE))
					.py(px(space::BASE))
					.rounded(px(radius::CARD))
					.bg(theme.raised)
					.border_1()
					.border_color(theme.stroke)
					.text_color(theme.text)
					.child(message.text()),
			)
			.into_any_element(),
		Role::Assistant => {
			let mut column = div().flex().flex_col().gap(px(space::WIDE)).w_full();
			for block in &message.blocks {
				column = column.child(render_block(shell, block, cx));
			}
			column.into_any_element()
		},
	}
}

fn render_block(shell: &mut Shell, block: &Block, cx: &mut Context<Shell>) -> AnyElement {
	let theme = Theme::get(cx);
	match block {
		Block::Text(text) => div()
			.w_full()
			.text_color(theme.text)
			.child(text.clone())
			.into_any_element(),

		Block::Code { lang, body } => div()
			.flex()
			.flex_col()
			.w_full()
			.rounded(px(radius::CHIP))
			.bg(theme.sunken)
			.border_1()
			.border_color(theme.stroke)
			.overflow_hidden()
			.child(
				ui::line_of(space::SNUG)
					.px(px(space::WIDE))
					.py(px(space::TIGHT))
					.bg(theme.window)
					.text_size(px(size::MICRO))
					.text_color(theme.text_faint)
					.child(lang.clone()),
			)
			.child(
				div()
					.px(px(space::WIDE))
					.py(px(space::BASE))
					.font_family(theme.font_mono)
					.text_size(px(size::SMALL))
					.text_color(theme.text)
					.child(body.clone()),
			)
			.into_any_element(),

		Block::Tool { name, target, output, state } => {
			let (color, word) = match state {
				ToolState::Running => (theme.accent, "running"),
				ToolState::Ok => (theme.success, "ok"),
				ToolState::Failed => (theme.danger, "failed"),
			};
			let phase = matches!(state, ToolState::Running)
				.then(|| shell.motion.phase(motion::SPIN_MS, shell.now));
			div()
				.flex()
				.flex_col()
				.gap(px(space::SNUG))
				.w_full()
				.child(
					ui::line_of(space::BASE)
						.child(
							div()
								.w(px(14.0))
								.text_size(px(size::META))
								.text_color(color)
								.when_some(phase, |element, phase| {
									element.opacity(0.4 + 0.6 * motion::wave(phase, 0, 1))
								})
								.child(ui::glyph::TOOL),
						)
						.child(
							div()
								.font_family(theme.font_mono)
								.text_size(px(size::SMALL))
								.text_color(theme.text)
								.child(name.clone()),
						)
						.child(
							ui::line(target.clone())
								.flex_1()
								.min_w(px(0.0))
								.font_family(theme.font_mono)
								.text_size(px(size::SMALL))
								.text_color(theme.text_faint),
						)
						.child(ui::chip(word, color, &theme).flex_none()),
				)
				.when(!output.is_empty(), |element| {
					element.child(
						div()
							.ml(px(22.0))
							.px(px(space::WIDE))
							.py(px(space::SNUG))
							.rounded(px(radius::CHIP))
							.bg(theme.sunken)
							.font_family(theme.font_mono)
							.text_size(px(size::SMALL))
							.text_color(theme.text_muted)
							.child(output.clone()),
					)
				})
				.into_any_element()
		},

		Block::Diff { path, lines } => {
			let added = lines.iter().filter(|(sign, _)| *sign == '+').count();
			let removed = lines.iter().filter(|(sign, _)| *sign == '-').count();
			let mut body = div().flex().flex_col().w_full().py(px(space::TIGHT));
			for (sign, text) in lines {
				let (ground, ink) = match sign {
					'+' => (theme.added, theme.success),
					'-' => (theme.removed, theme.danger),
					_ => (gpui::transparent_black(), theme.text_muted),
				};
				body = body.child(
					ui::line_of(space::BASE)
						.w_full()
						.px(px(space::WIDE))
						.bg(ground)
						.font_family(theme.font_mono)
						.text_size(px(size::SMALL))
						.child(
							div()
								.w(px(8.0))
								.flex_none()
								.text_color(ink)
								.child(sign.to_string()),
						)
						.child(
							div()
								.flex_1()
								.min_w(px(0.0))
								.text_color(theme.text)
								.child(text.clone()),
						),
				);
			}
			div()
				.flex()
				.flex_col()
				.w_full()
				.rounded(px(radius::CHIP))
				.bg(theme.sunken)
				.border_1()
				.border_color(theme.stroke)
				.overflow_hidden()
				.child(
					ui::line_of(space::BASE)
						.px(px(space::WIDE))
						.py(px(space::TIGHT))
						.bg(theme.window)
						.child(
							ui::line(path.clone())
								.flex_1()
								.min_w(px(0.0))
								.font_family(theme.font_mono)
								.text_size(px(size::META))
								.text_color(theme.text_muted),
						)
						.child(
							div()
								.flex_none()
								.text_size(px(size::MICRO))
								.text_color(theme.success)
								.child(format!("+{added}")),
						)
						.child(
							div()
								.flex_none()
								.text_size(px(size::MICRO))
								.text_color(theme.danger)
								.child(format!("-{removed}")),
						),
				)
				.child(body)
				.into_any_element()
		},
	}
}

/// Nothing selected: the one thing to do, and the ways to reach the rest.
fn empty(shell: &mut Shell, cx: &mut Context<Shell>) -> Div {
	let theme = Theme::get(cx);
	let now = shell.now;
	let appearing = shell
		.motion
		.enter(Key::of(Channel::Message), motion::ENTER, now);

	div()
		.flex()
		.flex_col()
		.items_center()
		.justify_center()
		.gap(px(space::BASE))
		.size_full()
		.bg(theme.canvas)
		.opacity(appearing)
		.child(
			div()
				.text_size(px(size::DISPLAY))
				.font_weight(gpui::FontWeight::SEMIBOLD)
				.text_color(theme.text)
				.child("veyyon"),
		)
		.child(
			div()
				.text_size(px(size::BODY))
				.text_color(theme.text_muted)
				.child("Pick a session, or start one."),
		)
		.child(
			ui::line_of(space::BASE)
				.mt(px(space::WIDE))
				.child(ui::tag("⌘N  new session", &theme))
				.child(ui::tag("⌘K  commands", &theme)),
		)
}
