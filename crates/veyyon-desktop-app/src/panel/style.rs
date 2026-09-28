//! Pieces every panel tab and the drawer draw the same way: the toolbar row,
//! a section heading, an empty state and highlighted mono text.

use std::{ops::Range, sync::Arc};

use veyyon_desktop_ui::{
	controls::{IconButton, Spinner},
	icons::IconName,
	markdown::Highlighted,
	theme::{Palette, TypeStyled, size, space, text},
};
use veyyon_gpui::{
	AnyElement, App, ClickEvent, Div, HighlightStyle, IntoElement, ParentElement, SharedString,
	Styled, StyledText, Window, div,
};

use crate::driver;

/// The row above a tab's content: its controls, `s3` from each side.
pub fn toolbar(palette: &Palette) -> Div {
	div()
		.flex()
		.flex_none()
		.items_center()
		.gap(space::S1)
		.h(size::CONTROL_LG)
		.px(space::S2)
		.border_b_1()
		.border_color(palette.border.subtle)
}

/// A muted heading over a group of rows.
pub fn heading(label: impl Into<SharedString>, palette: &Palette) -> Div {
	div()
		.flex()
		.items_center()
		.gap(space::S2)
		.px(space::S3)
		.pt(space::S3)
		.pb(space::S1)
		.type_style(text::SMALL)
		.text_color(palette.text.muted)
		.child(label.into())
}

/// One line of copy centered in the tab, and the one action that fills it.
pub fn empty_state(
	copy: impl Into<SharedString>,
	action: Option<impl IntoElement>,
	palette: &Palette,
) -> Div {
	div()
		.flex()
		.flex_col()
		.flex_1()
		.items_center()
		.justify_center()
		.gap(space::S3)
		.p(space::S6)
		.type_style(text::UI)
		.text_color(palette.text.muted)
		.child(copy.into())
		.children(action)
}

/// A tab's refresh control: a spinner while its request is in flight, and
/// disabled, with the host's reason as its tooltip, while the host refuses
/// it. The control is the driver target `id`.
pub fn refresh_control(
	id: &'static str,
	label: &'static str,
	pending: bool,
	unavailable: Option<String>,
	on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
	if pending {
		return div()
			.flex()
			.flex_none()
			.items_center()
			.justify_center()
			.size(size::CONTROL)
			.child(Spinner::new(id))
			.into_any_element();
	}
	let disabled = unavailable.is_some();
	driver::target(
		id,
		IconButton::new(id, IconName::RefreshCw)
			.tooltip(unavailable.unwrap_or_else(|| label.to_owned()))
			.disabled(disabled)
			.on_click(on_click),
	)
}

/// The spans of `highlighted` that fall inside `range` of the code it was
/// computed for, shifted so `range.start` is offset 0.
pub fn spans_in(
	highlighted: &Highlighted,
	range: Range<usize>,
	palette: &Palette,
) -> Vec<(Range<usize>, HighlightStyle)> {
	let spans = highlighted.spans();
	let first = spans.partition_point(|(span, _)| span.end <= range.start);
	spans[first..]
		.iter()
		.take_while(|(span, _)| span.start < range.end)
		.filter_map(|(span, role)| {
			let start = span.start.max(range.start) - range.start;
			let end = span.end.min(range.end) - range.start;
			(start < end).then(|| {
				(start..end, HighlightStyle {
					color: Some(role.color(&palette.syntax)),
					..HighlightStyle::default()
				})
			})
		})
		.collect()
}

/// One line of code in the mono face, colored by `highlighted` when its
/// spans have arrived and plain until then. `at` is where the line starts in
/// the code `highlighted` was computed for.
pub fn code_line(
	line: SharedString,
	highlighted: Option<&Arc<Highlighted>>,
	at: usize,
	palette: &Palette,
) -> StyledText {
	let styled = StyledText::new(line.clone());
	match highlighted {
		Some(highlighted) => {
			styled.with_highlights(spans_in(highlighted, at..at + line.len(), palette))
		},
		None => styled,
	}
}

/// The mono text style every code surface draws in.
pub fn mono(element: Div, palette: &Palette) -> Div {
	element
		.type_style(text::MONO)
		.text_color(palette.text.primary)
}

/// A count with its noun, `1 file` or `3 files`.
pub fn counted(count: u64, one: &str, many: &str) -> String {
	if count == 1 {
		format!("1 {one}")
	} else {
		format!("{count} {many}")
	}
}

/// `path`'s extension, or its file name for an extensionless file, which is
/// the tag the highlighter resolves a language from.
pub fn language_tag(path: &str) -> &str {
	let name = path.rsplit('/').next().unwrap_or(path);
	name
		.rsplit_once('.')
		.map_or(name, |(_, extension)| extension)
}

/// `ms` as its two largest units of days, hours and minutes: `3d 4h`,
/// `2h 14m`, `9m`.
pub fn span(ms: u64) -> String {
	let minutes = ms / 60_000;
	let (days, hours, minutes) = (minutes / 1440, minutes / 60 % 24, minutes % 60);
	match (days, hours) {
		(0, 0) => format!("{minutes}m"),
		(0, _) => format!("{hours}h {minutes}m"),
		_ => format!("{days}d {hours}h"),
	}
}

/// The wall clock in epoch milliseconds, which a time the host stated is
/// measured against when the tab renders.
pub fn now_ms() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map_or(0, |since| since.as_millis() as u64)
}
