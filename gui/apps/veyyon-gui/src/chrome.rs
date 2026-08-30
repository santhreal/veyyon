//! Small pieces more than one region draws: a chip, a row, a clock.
//!
//! Everything here takes a role and a token rather than a colour and a number,
//! so a piece cannot introduce a size or a colour the catalogs do not have.

use gpui::{App, Div, Hsla, ParentElement, Pixels, SharedString, Styled, div};
use veyyon_theme::Role;
use veyyon_ui::{
	ActiveTypography, Level, surface,
	theme::ActiveTheme,
	tokens::{radius, space, stroke, text},
};

/// A short label on a tinted ground: a status, an exit code, an attachment.
///
/// The ground is the role's own colour at low alpha, so a chip carries the
/// role's hue without needing a second colour in the theme for every state.
pub fn chip(label: impl Into<SharedString>, role: Role, cx: &App) -> Div {
	let color = cx.color(role);
	div()
		.px(space::TIGHT)
		.py(space::HAIR)
		.rounded(radius::SMALL)
		.bg(wash(color))
		.border(stroke::HAIRLINE)
		.border_color(edge(color))
		.text_size(text::MICRO)
		.text_color(color)
		.child(label.into())
}

/// A role's colour as a ground fill: the same hue, far enough back to read text
/// over.
pub fn wash(color: Hsla) -> Hsla {
	Hsla { a: color.a * 0.14, ..color }
}

/// A role's colour as an edge: the same hue, stronger than its fill.
pub fn edge(color: Hsla) -> Hsla {
	Hsla { a: color.a * 0.40, ..color }
}

/// A horizontal run of children, vertically centred, with a gap between them.
pub fn row(gap: Pixels) -> Div {
	div().flex().flex_row().items_center().gap(gap)
}

/// A vertical stack with a gap between children.
pub fn column(gap: Pixels) -> Div {
	div().flex().flex_col().gap(gap)
}

/// A monospace block on a well: command output, a tool payload, code.
///
/// Sunken rather than a bare background, so output looks like something the
/// session produced rather than something the card says.
pub fn well(body: impl Into<SharedString>, role: Role, cx: &App) -> Div {
	surface(Level::Sunken, cx)
		.p(space::SNUG)
		.font_family(cx.mono_family())
		.text_size(text::SMALL)
		.text_color(cx.color(role))
		.child(body.into())
}

/// A one-pixel rule across its container.
pub fn rule(role: Role, cx: &App) -> Div {
	div().h(stroke::HAIRLINE).w_full().bg(cx.color(role))
}

/// A wire timestamp as a clock time, `HH:MM:SS` in UTC.
///
/// Computed rather than delegated: a date library is a dependency for one
/// format, and the transcript shows a time of day and nothing else. UTC because
/// the contract carries an instant and no timezone.
pub fn clock(timestamp_ms: i64) -> String {
	let seconds = timestamp_ms.div_euclid(1_000).rem_euclid(86_400);
	let (hours, minutes, seconds) = (seconds / 3_600, (seconds % 3_600) / 60, seconds % 60);
	format!("{hours:02}:{minutes:02}:{seconds:02}")
}

/// A byte count as a short string: `120 B`, `4.0 MB`.
pub fn bytes(count: u64) -> String {
	const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
	let mut value = count as f64;
	let mut unit = 0;
	while value >= 1_024.0 && unit + 1 < UNITS.len() {
		value /= 1_024.0;
		unit += 1;
	}
	let label = UNITS[unit];
	if unit == 0 {
		format!("{count} {label}")
	} else {
		format!("{value:.1} {label}")
	}
}

/// A millisecond duration as a short string: `42ms`, `1.4s`.
pub fn duration(ms: u64) -> String {
	if ms < 1_000 {
		format!("{ms}ms")
	} else {
		format!("{:.1}s", ms as f64 / 1_000.0)
	}
}

/// A token count as a short string: `980`, `42.0k`.
pub fn tokens(count: u64) -> String {
	if count < 1_000 {
		count.to_string()
	} else {
		format!("{:.1}k", count as f64 / 1_000.0)
	}
}

/// WHY THIS SUITE EXISTS.
///
/// Every number the shell puts on screen goes through one of these formatters,
/// and the failure it closes is a value that reads as a different value: a
/// clock that rolls over wrong, a byte count that truncates, a duration that
/// loses its unit, a chip whose fill is in front of its edge.
///
/// WHAT IT DOES NOT CATCH. Layout, and whether a piece is reachable on screen.
/// Both need a window and belong to the app's own capture.
#[cfg(test)]
mod tests {
	use super::*;

	/// A clock is the time of day at that instant, and it wraps at midnight
	/// rather than running past 24 hours. A negative instant is before the epoch
	/// and still has a time of day, which is why the arithmetic is euclidean —
	/// `%` would yield a negative hour.
	#[test]
	fn a_clock_is_the_time_of_day_and_wraps_at_midnight() {
		assert_eq!(clock(0), "00:00:00");
		assert_eq!(clock(1_000), "00:00:01");
		assert_eq!(clock(3_661_000), "01:01:01");
		assert_eq!(clock(86_399_000), "23:59:59");
		assert_eq!(clock(86_400_000), "00:00:00");
		assert_eq!(clock(86_400_000 + 3_600_000), "01:00:00");
		assert_eq!(clock(-1_000), "23:59:59");
	}

	/// A byte count keeps its exact value in bytes, switches unit at the
	/// boundary rather than near it, and holds at the largest unit rather than
	/// running off the end of the table.
	#[test]
	fn a_byte_count_switches_unit_at_the_boundary() {
		assert_eq!(bytes(0), "0 B");
		assert_eq!(bytes(1_023), "1023 B");
		assert_eq!(bytes(1_024), "1.0 KB");
		assert_eq!(bytes(1_048_575), "1024.0 KB");
		assert_eq!(bytes(1_048_576), "1.0 MB");
		assert_eq!(bytes(u64::MAX), "17179869184.0 GB");
	}

	/// A duration below a second keeps millisecond resolution and above it loses
	/// it. Both carry a unit.
	#[test]
	fn a_duration_carries_its_unit_on_both_sides_of_a_second() {
		assert_eq!(duration(0), "0ms");
		assert_eq!(duration(999), "999ms");
		assert_eq!(duration(1_000), "1.0s");
		assert_eq!(duration(1_400), "1.4s");
	}

	/// A token count is exact below a thousand, because the difference between
	/// 12 and 120 tokens is the whole reading of a short turn.
	#[test]
	fn a_token_count_is_exact_below_a_thousand() {
		assert_eq!(tokens(0), "0");
		assert_eq!(tokens(999), "999");
		assert_eq!(tokens(1_000), "1.0k");
		assert_eq!(tokens(42_000), "42.0k");
	}

	/// A chip's fill sits behind its text and its edge in front of its fill.
	/// Equal alphas make the chip a flat blob with no edge.
	#[test]
	fn a_chip_fill_is_further_back_than_its_edge() {
		let color = Hsla { h: 0.5, s: 0.5, l: 0.5, a: 1.0 };
		assert!(wash(color).a < edge(color).a);
		assert!(edge(color).a < color.a);
		assert_eq!(wash(color).h, color.h);
	}

	/// A role that is already partly transparent stays proportionally so.
	/// Ignoring the incoming alpha would make a faded role's chip more opaque
	/// than the role it came from.
	#[test]
	fn a_transparent_role_keeps_its_proportions() {
		let faded = Hsla { h: 0.5, s: 0.5, l: 0.5, a: 0.5 };
		assert!(wash(faded).a < wash(Hsla { a: 1.0, ..faded }).a);
	}
}
