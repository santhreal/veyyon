//! What a tool did.
//!
//! One folded row per call: the glyph for the kind of thing it was, the one
//! line that names it, where it is, and the output behind a disclosure. A
//! transcript that prints every tool's output inline is a transcript where the
//! prose is unfindable, and a transcript that hides the output entirely cannot
//! be checked against what happened.
//!
//! FOLDED BY DEFAULT, EXCEPT WHEN IT FAILED. A reader scrolling past a run of
//! successful calls wants the lines; a reader looking at a failure wants the
//! text. So the fold's default follows the state rather than being one policy.
//!
//! WHAT WAITS IS NOT WHAT RUNS. A call waiting to be allowed is not making
//! progress, so it does not turn: a spinner on something that is not moving is
//! a lie the reader believes for as long as it spins.

use gpui::{App, Div, ParentElement, Styled, div, px};
use veyyon_gui_core::store::model::{ToolCall, ToolKind, ToolState};
use veyyon_gui_kit::{
	theme::{Theme, radius, size, space},
	ui::{Badge, Disclosure, Icon, Size, Spinner, Tone, text},
};

/// One call.
pub fn call(call: &ToolCall, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let open = matches!(call.state, ToolState::Failed(_));
	let has_detail = !call.detail.trim().is_empty();

	let mut header = Disclosure::new(format!("tool-{}", call.id), call.what.clone())
		.icon(mark(call.kind))
		.open(open && has_detail);

	// The state, at the far end, in the one form that fits a row: a turning
	// mark while it runs, a word once it is over, nothing at all when it did
	// what it said. A green tick on every successful call is a column of green
	// ticks nobody reads.
	match &call.state {
		ToolState::Running => {
			header = header.count("running");
		},
		ToolState::Waiting => {
			header = header.count("waiting");
		},
		ToolState::Failed(_) => {
			header = header.count("failed");
		},
		ToolState::Done => {},
	}

	let mut column = text::stack(space::TIGHT).w_full().child(header);

	// A running call gets the turning mark on its own line rather than inside
	// the row, so the row's text does not shift when it stops.
	if matches!(call.state, ToolState::Running) {
		column = column.child(
			div().pl(px(space::LOOSE)).child(
				Spinner::new(format!("tool-spin-{}", call.id))
					.size(Size::Small)
					.what("Running"),
			),
		);
	}
	if let ToolState::Waiting = call.state {
		column = column.child(
			div().pl(px(space::LOOSE)).child(
				Badge::new("Waiting to be allowed")
					.tone(Tone::Warn)
					.icon(Icon::Allow),
			),
		);
	}
	if let ToolState::Failed(why) = &call.state
		&& !why.trim().is_empty()
	{
		column = column.child(
			div().pl(px(space::LOOSE)).child(
				Badge::new(why.clone())
					.tone(Tone::Danger)
					.icon(Icon::Failed)
					.exact(),
			),
		);
	}

	if has_detail && open {
		column = column.child(detail(&call.detail, &theme));
	}
	column
}

/// What a call produced: a well of mono text, indented under the row it belongs
/// to.
fn detail(text_body: &str, theme: &Theme) -> Div {
	div()
		.w_full()
		.ml(px(space::LOOSE))
		.px(px(space::BASE))
		.py(px(space::SNUG))
		.rounded(px(radius::CHIP))
		.bg(theme.sunken)
		.overflow_hidden()
		.child(
			text::mono(text_body.to_owned(), theme)
				.w_full()
				.text_size(px(size::SMALL))
				.line_height(px(size::SMALL * size::LINE_CODE))
				.text_color(theme.text_muted),
		)
}

/// The glyph for a kind of call.
pub fn mark(kind: ToolKind) -> Icon {
	match kind {
		ToolKind::Ran => Icon::Ran,
		ToolKind::Read => Icon::Read,
		ToolKind::Edited => Icon::Edited,
		ToolKind::Searched => Icon::Search,
		ToolKind::Other => Icon::Tool,
	}
}
