//! Where the session queue rail is drawn at the width the shed resolved.
//!
//! Two placements, one rail. Inline, it is a column of the root row and takes
//! its width from the transcript beside it. Floated, it spans the whole row
//! over the surfaces below the titlebar, because at that width it is the only
//! way to reach another session and a rail that shed its footer would strand
//! every session but the open one (§5.14).

use veyyon_desktop_kit::{Sheet, TokenSet};
use veyyon_desktop_tokens::SurfaceTokens;
use veyyon_gpui::{
	AnyElement, Context, InteractiveElement, IntoElement, MouseButton, MouseDownEvent,
	ParentElement, Styled, Window, div, px,
};

use crate::{
	ShellView,
	damage::Region,
	layout::{QueuePlacement, ShellWidths},
	queue::queue_rail,
};

/// The rail as a frame carries it: at most one of the two is built, and both
/// are absent at a width that sheds the rail with the float closed.
pub struct QueueColumn {
	/// The rail as a column beside the session surface.
	pub inline: Option<AnyElement>,
	/// The scrim and the sheet a floated rail is drawn in.
	pub float:  Option<AnyElement>,
}

/// Builds the rail for the placement the shed resolved.
pub fn queue_column(
	view: &mut ShellView,
	widths: &ShellWidths,
	surface: &SurfaceTokens,
	tokens: &TokenSet,
	window: &mut Window,
	cx: &Context<ShellView>,
) -> QueueColumn {
	let mut column = QueueColumn { inline: None, float: None };
	if !widths.queue.is_shown() {
		return column;
	}

	let queue_focus = view
		.queue_focus
		.get_or_insert_with(|| cx.focus_handle())
		.clone();
	let rail_layout = view.laid_out.clone();
	let rail = queue_rail(
		&view.state.sections,
		view.state.keymap.queue_filter.as_deref(),
		view.state.current_id,
		// The declared measure is the rail's outer width in either
		// placement, so a floated rail hands the sheet's own frame back
		// and lands its rows in the same 208px the docked one draws in.
		match widths.queue {
			QueuePlacement::Overlay { width_px } => {
				f32::from(Sheet::inset(tokens)).mul_add(-2.0, width_px)
			},
			QueuePlacement::Inline { width_px } => width_px,
			QueuePlacement::Absent => 0.0,
		},
		widths.columns_px,
		&view.state.controls,
		&surface.queue,
		tokens,
		&mut view.rail_motion,
		&queue_focus,
		&rail_layout,
		window,
		cx,
	)
	.into_any_element();

	match widths.queue {
		QueuePlacement::Inline { .. } => column.inline = Some(rail),
		// The float spans the columns row, not the transcript inside it.
		// The queue is not an annotation of what is being read, the way
		// the right panel is: it is the only way to reach another session
		// at this width, so it draws every row and its footer at the
		// height a docked column would have had. That makes it modal
		// while it is open, and it closes on the control, on Escape, and
		// on a press outside it.
		QueuePlacement::Overlay { .. } => column.float = Some(float_over_row(view, rail, tokens, cx)),
		QueuePlacement::Absent => {},
	}
	column
}

/// Wraps the rail in the scrim and the sheet a float is drawn in.
///
/// The scrim swallows the pointer over the row it dims, so a press meant to
/// dismiss the rail does not also answer the card or the control it landed on.
/// The rail itself takes the press outside its own box as the dismissal.
fn float_over_row(
	view: &ShellView,
	rail: AnyElement,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	let blur_px = view
		.installed()
		.surface
		.panels
		.right_panel_overlay_scrim_blur_px;
	let sheet = div()
		.id("queue-float")
		.occlude()
		.on_mouse_down_out(cx.listener(|view, event: &MouseDownEvent, _window, cx| {
			if event.button == MouseButton::Left && view.close_queue_float() {
				cx.stop_propagation();
				cx.notify();
			}
		}))
		.child(Sheet::left(rail));
	view
		.laid_out()
		.track_children(
			div()
				.absolute()
				.inset_0()
				.flex()
				.flex_row()
				.justify_start()
				.occlude()
				.backdrop_blur(px(blur_px))
				.bg(tokens.scrim())
				.child(sheet),
			|index| (index == 0).then_some(Region::Queue),
		)
		.into_any_element()
}
