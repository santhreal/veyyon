//! Recursive split topology over retained renderer leaves.

use gpui::{AnyElement, App, IntoElement, ParentElement, Styled, div, px, relative};
use veyyon_gui_core::{
	Store,
	model::{SplitAxis, TerminalId, TerminalLayout, TerminalRunView},
};
use veyyon_gui_kit::{
	theme::{Theme, layout, space},
	ui::{Badge, Banner, Tone, text},
};

use super::{ConnectionPresentation, RendererAdapter, ViewportState, lifecycle};

pub fn render(
	store: &Store,
	terminals: &[TerminalRunView],
	selected: &TerminalId,
	renderer: &mut (dyn RendererAdapter + 'static),
	cx: &mut App,
) -> AnyElement {
	let layout = store.frontend.terminal_layout.as_ref();
	match layout {
		Some(layout) => node(layout, terminals, selected, store, renderer, cx),
		None => leaf(selected, terminals, selected, store, renderer, cx),
	}
}

fn node(
	layout: &TerminalLayout,
	terminals: &[TerminalRunView],
	selected: &TerminalId,
	store: &Store,
	renderer: &mut (dyn RendererAdapter + 'static),
	cx: &mut App,
) -> AnyElement {
	match layout {
		TerminalLayout::Leaf(terminal) => leaf(terminal, terminals, selected, store, renderer, cx),
		TerminalLayout::Split { axis, ratio_milli, first, second } => {
			let ratio = (f32::from(*ratio_milli) / 1000.0).clamp(0.0, 1.0);
			let horizontal = matches!(axis, SplitAxis::Horizontal);
			let first_view = node(first, terminals, selected, store, renderer, cx);
			let second_view = node(second, terminals, selected, store, renderer, cx);
			let theme = Theme::get(cx);
			let mut root = div()
				.flex()
				.size_full()
				.min_w(px(0.0))
				.min_h(px(0.0))
				.gap(px(space::PAIR))
				.bg(theme.stroke);
			if !horizontal {
				root = root.flex_col();
			}
			let first_box = if horizontal {
				div().w(relative(ratio))
			} else {
				div().h(relative(ratio))
			};
			let second_box = if horizontal {
				div().w(relative(1.0 - ratio))
			} else {
				div().h(relative(1.0 - ratio))
			};
			root
				.child(
					first_box
						.flex_none()
						.min_w(px(0.0))
						.min_h(px(0.0))
						.bg(theme.sunken)
						.child(first_view),
				)
				.child(
					second_box
						.flex_none()
						.min_w(px(0.0))
						.min_h(px(0.0))
						.bg(theme.sunken)
						.child(second_view),
				)
				.into_any_element()
		},
	}
}

fn leaf(
	terminal: &TerminalId,
	terminals: &[TerminalRunView],
	selected: &TerminalId,
	store: &Store,
	renderer: &mut (dyn RendererAdapter + 'static),
	cx: &mut App,
) -> AnyElement {
	let Some(run) = terminals.iter().find(|candidate| &candidate.id == terminal) else {
		return div()
			.size_full()
			.p(px(space::WIDE))
			.child(Banner::failure("Terminal session is unavailable"))
			.into_any_element();
	};
	let presentation = lifecycle(run, &store.connection, None);
	let theme = Theme::get(cx);
	let mut leaf = div()
		.flex()
		.flex_col()
		.size_full()
		.min_w(px(0.0))
		.min_h(px(0.0))
		.child(
			div()
				.flex()
				.items_center()
				.gap(px(space::BASE))
				.px(px(space::SNUG))
				.h(px(layout::control_height()))
				.child(
					text::line(run.cwd.clone())
						.font_family(theme.font_mono)
						.text_color(theme.text_muted),
				)
				.child(text::spacer())
				.child(Badge::new(format!("{} lines", run.total_lines)).exact())
				.children(run.exit_code.map(|code| {
					Badge::new(format!("exit {code}"))
						.exact()
						.tone(if code == 0 { Tone::Ok } else { Tone::Danger })
				}))
				.children(
					run.signal
						.as_ref()
						.map(|signal| Badge::new(signal.clone()).exact().tone(Tone::Danger)),
				)
				.children(
					run.cancelled
						.then(|| Badge::new("cancelled").tone(Tone::Warn)),
				)
				.children(
					run.truncated
						.then(|| Badge::new("truncated").tone(Tone::Warn)),
				),
		);
	if let Some(detail) = presentation.detail {
		let banner = if presentation.tone == Tone::Danger {
			Banner::failure(presentation.label).detail(detail.to_owned())
		} else {
			Banner::waiting(presentation.label).detail(detail.to_owned())
		};
		leaf = leaf.child(div().px(px(space::SNUG)).py(px(space::TIGHT)).child(banner));
	}
	leaf
		.child(
			div().flex_1().min_h(px(0.0)).child(
				renderer.viewport(
					terminal,
					ViewportState {
						focused:       terminal == selected,
						stale:         ConnectionPresentation::from_connection(&store.connection).stale,
						accepts_input: presentation.accepts_input,
						search:        store
							.frontend
							.terminal_search
							.get(terminal)
							.map(String::as_str),
						follow_tail:   store.frontend.terminal_follow_tail.contains(terminal),
					},
					cx,
				),
			),
		)
		.into_any_element()
}
