//! The bottom panel: what the agent ran, and what it printed.
//!
//! The tab strip is always on screen and the output is what collapses. A panel
//! that disappears entirely takes its own handle with it, so reopening it means
//! finding a menu item; a strip that stays is one click from the output and
//! costs thirty pixels.
//!
//! A tab says whether it is still going and how it ended in the same place: a
//! breathing cell while it runs, then its exit code. A zero is quiet and a
//! non-zero is not, because a command that failed is the reason to look at this
//! panel at all.

use gpui::{
	Context, Div, InteractiveElement, MouseButton, ParentElement, Stateful,
	StatefulInteractiveElement, Styled, div, prelude::FluentBuilder, px,
};

use crate::{
	motion::{self, Channel, Key},
	shell::Shell,
	state::moves,
	theme::{Theme, layout, radius, size, space},
	ui,
};

/// The two commands the strip runs directly. Everything else arrives from the
/// palette or from a session.
const QUICK: [(&str, &str); 2] = [("check", "cargo check"), ("test", "bun test")];

pub fn render(shell: &mut Shell, cx: &mut Context<Shell>) -> Div {
	let theme = Theme::get(cx);
	div()
		.flex()
		.flex_col()
		.size_full()
		.min_h(px(0.0))
		.child(ui::hairline(&theme))
		.child(strip(shell, cx))
		.child(output(shell, cx))
}

/// The tab strip, which is the part that never goes away.
fn strip(shell: &mut Shell, cx: &mut Context<Shell>) -> Div {
	let theme = Theme::get(cx);
	let now = shell.now;
	let active = shell.store.terminal.active;
	let open = shell.store.terminal.open;
	let tabs: Vec<Tab> = shell
		.store
		.terminal
		.tabs
		.iter()
		.enumerate()
		.map(|(index, tab)| Tab {
			index,
			id: tab.id,
			title: tab.title.clone(),
			running: tab.is_running(),
			exit: tab.exit,
			failed: tab.failed(),
			active: index == active,
		})
		.collect();

	let mut strip = div()
		.id("terminal-strip")
		.flex()
		.items_center()
		.gap(px(space::HAIR))
		.h(px(layout::TERMINAL_STRIP))
		.flex_none()
		.px(px(space::SNUG))
		.overflow_x_scroll();

	for tab in tabs {
		strip = strip.child(tab.render(shell, cx));
	}

	let mut quick = ui::line_of(space::TIGHT).flex_none();
	for (label, command) in QUICK {
		let key = Key::named(Channel::Control, label);
		let ground = ui::wash(&mut shell.motion, key, gpui::transparent_black(), theme.hover(), now);
		quick = quick.child(
			div()
				.id(label)
				.flex()
				.items_center()
				.h(px(20.0))
				.px(px(space::SNUG))
				.rounded(px(radius::CHIP))
				.bg(ground)
				.text_size(px(size::MICRO))
				.text_color(theme.text_faint)
				.cursor_pointer()
				.on_hover(cx.listener(move |shell, hovered: &bool, window, _| {
					let now = shell.now;
					shell.motion.flip(key, *hovered, motion::WASH, now);
					window.refresh();
				}))
				.on_click(cx.listener(move |shell, _, _, cx| {
					moves::run_command(&mut shell.store, command);
					cx.notify();
				}))
				.child(label),
		);
	}

	div()
		.flex()
		.items_center()
		.w_full()
		.flex_none()
		.bg(theme.panel)
		.child(strip.flex_1().min_w(px(0.0)))
		.child(quick)
		.child(
			div()
				.id("terminal-toggle")
				.flex()
				.items_center()
				.justify_center()
				.size(px(22.0))
				.flex_none()
				.mr(px(space::TIGHT))
				.rounded(px(radius::CHIP))
				.text_size(px(size::MICRO))
				.text_color(theme.text_faint)
				.cursor_pointer()
				.on_click(cx.listener(|shell, _, _, cx| {
					moves::toggle_terminal(&mut shell.store);
					cx.notify();
				}))
				.child(if open { "\u{2304}" } else { "\u{2303}" }),
		)
}

/// One tab in the strip.
///
/// The fields are read off the store before the strip borrows it mutably, so
/// they travel as a value rather than as eight positional arguments.
struct Tab {
	index:   usize,
	id:      u64,
	title:   String,
	running: bool,
	exit:    Option<i32>,
	failed:  bool,
	active:  bool,
}

impl Tab {
	fn render(self, shell: &mut Shell, cx: &mut Context<Shell>) -> Stateful<Div> {
		let Tab { index, id, title, running, exit, failed, active } = self;
		let theme = Theme::get(cx);
		let now = shell.now;
		let key = Key::at(Channel::Tab, id);
		let hover = shell.motion.value(key, now);
		let rest = if active {
			theme.canvas
		} else {
			gpui::transparent_black()
		};
		let ground = motion::mix(rest, if active { theme.canvas } else { theme.hover() }, hover);
		let phase = running.then(|| shell.motion.phase(motion::SPIN_MS, now));
		let ink = if failed {
			theme.danger
		} else {
			theme.text_muted
		};

		div()
			.id(gpui::ElementId::Name(format!("tab-{id}").into()))
			.flex()
			.items_center()
			.gap(px(space::SNUG))
			.h(px(24.0))
			.flex_none()
			.max_w(px(220.0))
			.px(px(space::BASE))
			.rounded(px(radius::CHIP))
			.bg(ground)
			.cursor_pointer()
			.on_hover(cx.listener(move |shell, hovered: &bool, window, _| {
				let now = shell.now;
				shell.motion.flip(key, *hovered, motion::WASH, now);
				window.refresh();
			}))
			.on_click(cx.listener(move |shell, _, _, cx| {
				moves::select_terminal_tab(&mut shell.store, index);
				shell.store.terminal.open = true;
				cx.notify();
			}))
			.when_some(phase, |element, phase| {
				element.child(
					div().size(px(5.0)).flex_none().rounded(px(2.5)).bg(
						theme
							.accent
							.opacity(0.35 + 0.65 * motion::wave(phase, 0, 1)),
					),
				)
			})
			.child(
				ui::line(title)
					.min_w(px(0.0))
					.font_family(theme.font_mono)
					.text_size(px(size::MICRO))
					.text_color(if active { theme.text } else { ink }),
			)
			.when_some(exit.filter(|_| failed), |element, code| {
				element.child(ui::chip(format!("exit {code}"), theme.danger, &theme).flex_none())
			})
			.child(
				div()
					.id(gpui::ElementId::Name(format!("close-{id}").into()))
					.flex_none()
					.opacity(if active { 1.0 } else { hover })
					.text_size(px(size::MICRO))
					.text_color(theme.text_faint)
					.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
					.on_click(cx.listener(move |shell, _, _, cx| {
						moves::close_terminal_tab(&mut shell.store, index);
						cx.notify();
					}))
					.child(ui::glyph::CLOSE),
			)
	}
}

/// The active tab's output.
fn output(shell: &mut Shell, cx: &mut Context<Shell>) -> Stateful<Div> {
	let theme = Theme::get(cx);
	let tab = shell.store.terminal.active_tab();
	let cwd = tab.map(|tab| tab.cwd.clone()).unwrap_or_default();
	let lines: Vec<String> = tab.map(|tab| tab.lines.clone()).unwrap_or_default();
	let running = tab.is_some_and(|tab| tab.is_running());
	let empty = lines.is_empty();

	// Output follows while the command is going and stays put once it has
	// finished, which is when the reader starts scrolling back through it.
	let offset = shell.terminal_scroll.offset().y;
	let max = shell.terminal_scroll.max_offset().y;
	if running && f32::from(max + offset).abs() < 40.0 {
		shell.terminal_scroll.scroll_to_bottom();
	}

	let mut body = div()
		.flex()
		.flex_col()
		.w_full()
		.px(px(space::WIDE))
		.py(px(space::SNUG));
	if empty {
		body = body.child(
			div()
				.text_size(px(size::META))
				.text_color(theme.text_faint)
				.child(if running {
					"Waiting for output"
				} else {
					"Nothing has run here yet"
				}),
		);
	} else {
		body = body.child(
			div()
				.pb(px(space::TIGHT))
				.text_size(px(size::MICRO))
				.text_color(theme.text_faint)
				.child(cwd),
		);
		for line in lines {
			body = body.child(
				div()
					.w_full()
					.font_family(theme.font_mono)
					.text_size(px(size::SMALL))
					.text_color(theme.text_muted)
					.child(line),
			);
		}
	}

	div()
		.id("terminal-output")
		.flex()
		.flex_col()
		.flex_1()
		.min_h(px(0.0))
		.w_full()
		.overflow_y_scroll()
		.track_scroll(&shell.terminal_scroll)
		.bg(theme.panel)
		.child(body)
}
