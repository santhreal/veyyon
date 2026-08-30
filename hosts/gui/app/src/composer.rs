//! Where a turn is written.
//!
//! Docked, never floating over the transcript: a field that hovers costs the
//! last line of the conversation to a drop shadow, and the last line is the one
//! being read. It sits on the same reading column as the transcript so the
//! caret is under the text it answers.
//!
//! ONE CONTROL, TWO STATES. Send and Stop are one button that changes what it
//! is, because they are never both available and a second button would be dead
//! half the time. It carries a fill only when there is something to send.
//!
//! WAITING. A run that stopped to ask something turns the band into the answer:
//! the question's two ordinary answers become chips that send themselves, and
//! the field still takes anything else. That is the one place the app puts
//! words in the operator's mouth, and it is cheaper than typing "yes" to a
//! machine.

use gpui::{
	Context, Div, Focusable, InteractiveElement, ParentElement, StatefulInteractiveElement, Styled,
	Window, div, prelude::FluentBuilder, px,
};

use crate::{
	input::Editor,
	motion::{self, Channel, Key},
	shell::Shell,
	state::{
		model::{Activity, PaletteKind},
		moves,
	},
	theme::{Theme, layout, radius, size, space},
	ui,
};

/// The answers a waiting run is offered, which are the two it almost always
/// gets.
const QUICK: [(&str, &str); 2] = [("Go ahead", "yes"), ("Stop there", "no")];

pub fn render(shell: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) -> Div {
	let theme = Theme::get(cx);
	let now = shell.now;
	let focused = shell.composer.read(cx).focus_handle(cx).is_focused(window);
	let has_session = shell.store.selected.is_some();

	let (running, waiting, draft_empty, model) = shell
		.store
		.selected_session()
		.map(|session| {
			(
				session.run.is_some(),
				session.status == Activity::Waiting,
				session.draft.trim().is_empty(),
				session.model.clone(),
			)
		})
		.unwrap_or((false, false, true, String::new()));

	// The notice is a line, not a toast: a box that appears over the corner of
	// the window has to be dismissed, and this says something for four seconds
	// and then stops.
	let notice = shell.store.notice.clone();
	let notice_key = Key::of(Channel::Notice);
	let showing =
		shell
			.motion
			.drive(notice_key, motion::FADE, if notice.is_some() { 1.0 } else { 0.0 }, now);

	div()
		.flex()
		.flex_col()
		.items_center()
		.w_full()
		.flex_none()
		.px(px(space::HUGE))
		.pb(px(space::WIDE))
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
				.when(waiting, |element| element.child(quick_answers(shell, cx)))
				.child(pill(shell, focused, running, draft_empty, has_session, model, cx)),
		)
}

/// The two answers a waiting run is offered.
fn quick_answers(shell: &mut Shell, cx: &mut Context<Shell>) -> Div {
	let theme = Theme::get(cx);
	let now = shell.now;
	let mut line = ui::line_of(space::SNUG);
	for (label, key) in QUICK {
		let motion_key = Key::named(Channel::Control, key);
		let ground = ui::wash(&mut shell.motion, motion_key, theme.sunken, theme.hover(), now);
		line = line.child(
			div()
				.id(key)
				.flex()
				.items_center()
				.h(px(24.0))
				.px(px(space::WIDE))
				.rounded(px(radius::PILL))
				.bg(ground)
				.border_1()
				.border_color(theme.stroke)
				.text_size(px(size::META))
				.text_color(theme.text_muted)
				.cursor_pointer()
				.on_hover(cx.listener(move |shell, hovered: &bool, window, _| {
					let now = shell.now;
					shell.motion.flip(motion_key, *hovered, motion::WASH, now);
					window.refresh();
				}))
				.on_click(cx.listener(move |shell, _, _, cx| {
					moves::answer(&mut shell.store, label);
					shell.pull_draft(cx);
					cx.notify();
				}))
				.child(label),
		);
	}
	line
}

/// The field itself, and the row of controls under it.
fn pill(
	shell: &mut Shell,
	focused: bool,
	running: bool,
	draft_empty: bool,
	has_session: bool,
	model: String,
	cx: &mut Context<Shell>,
) -> Div {
	let theme = Theme::get(cx);
	let now = shell.now;
	let edge_key = Key::named(Channel::Control, "composer-edge");
	// The focus ring fades in rather than snapping, which is the difference
	// between a field that was focused and a field that lit up.
	let lit = shell
		.motion
		.drive(edge_key, motion::FADE, if focused { 1.0 } else { 0.0 }, now);
	let border = motion::mix(theme.stroke, theme.ring, lit);

	let send_key = Key::named(Channel::Control, "send");
	let send_hover = shell.motion.value(send_key, now);
	let armed = !draft_empty && has_session;
	let send_ground = if running {
		motion::mix(theme.danger.opacity(0.16), theme.danger.opacity(0.30), send_hover)
	} else if armed {
		motion::mix(theme.accent, theme.accent.opacity(0.82), send_hover)
	} else {
		motion::mix(theme.sunken, theme.hover(), send_hover)
	};
	let send_ink = if running {
		theme.danger
	} else if armed {
		theme.text_on_accent
	} else {
		theme.text_faint
	};

	let model_key = Key::named(Channel::Control, "composer-model");
	let model_ground =
		ui::wash(&mut shell.motion, model_key, gpui::transparent_black(), theme.hover(), now);

	div()
		.flex()
		.flex_col()
		.gap(px(space::SNUG))
		.w_full()
		.p(px(space::BASE))
		.rounded(px(radius::SHEET))
		.bg(theme.sunken)
		.border_1()
		.border_color(border)
		// The pill is one field as far as a pointer is concerned. A press on
		// its padding, its hint row or the space beside the text puts the
		// keyboard in it rather than taking the keyboard away from it.
		.on_mouse_down(
			gpui::MouseButton::Left,
			cx.listener(|shell, _, window: &mut Window, cx| {
				Editor::focus(&shell.composer, window, cx);
			}),
		)
		.child(div().px(px(space::TIGHT)).child(shell.composer.clone()))
		.child(
			ui::line_of(space::SNUG)
				.child(
					div()
						.id("composer-model")
						.flex()
						.items_center()
						.h(px(22.0))
						.px(px(space::SNUG))
						.rounded(px(radius::CHIP))
						.bg(model_ground)
						.text_size(px(size::MICRO))
						.text_color(theme.text_faint)
						.cursor_pointer()
						.on_hover(cx.listener(move |shell, hovered: &bool, window, _| {
							let now = shell.now;
							shell.motion.flip(model_key, *hovered, motion::WASH, now);
							window.refresh();
						}))
						.on_click(cx.listener(|shell, _, window, cx| {
							shell.show_palette(PaletteKind::Model, window, cx);
						}))
						.child(if model.is_empty() {
							"Pick a model".to_owned()
						} else {
							model
						}),
				)
				.child(ui::spacer())
				.child(
					div()
						.text_size(px(size::MICRO))
						.text_color(theme.text_faint)
						.child(if running {
							"esc  stop"
						} else {
							"⏎ send   ⇧⏎ newline"
						}),
				)
				.child(
					div()
						.id("send")
						.flex()
						.items_center()
						.justify_center()
						.size(px(26.0))
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
							if running {
								moves::interrupt(&mut shell.store);
							} else if moves::send(&mut shell.store) {
								shell.composer.update(cx, |editor, cx| editor.clear(cx));
								Editor::focus(&shell.composer, window, cx);
							}
							cx.notify();
						}))
						.child(if running {
							ui::glyph::STOP
						} else {
							ui::glyph::SEND
						}),
				),
		)
}
