//! The middle column: transcript, attached cards, composer, run bar, drawer.
//!
//! The column is the surface being read, so it is the one region that takes
//! whatever width the queue and the right panel leave. Everything in it shares
//! the composer's measure, so a decision, the reply to it and the line stating
//! what the session is doing all sit in one column rather than three.

use veyyon_desktop_kit::SpacingStep;
use veyyon_desktop_tokens::DrawerPlacement;
use veyyon_gpui::{Context, Div, ParentElement, Styled, div, px};

use crate::{
	ShellView,
	cards::card_stack,
	composer::{composer, opening_line, run_bar},
	drawer::terminal_drawer,
	layout::ShellWidths,
	model::ShellState,
	tokens::InstalledTokens,
	transcript::transcript_column,
};

/// Builds the session surface for the state and the resolved widths.
pub fn session_surface(
	state: &ShellState,
	widths: &ShellWidths,
	installed: &InstalledTokens,
	cx: &Context<ShellView>,
) -> Div {
	let tokens = &installed.set;
	let surface = &installed.surface;

	// The transcript is anchored to the bottom of its region, so a short run
	// sits against the composer rather than stranded at the top of the window,
	// and a long run keeps its most recent end visible.
	//
	// A long run's older turns are clipped rather than scrolled. This fork
	// exposes no scroll on a plain container, so scrolling needs the
	// virtualized transcript list, which is not built yet; until it is, the
	// region shows the tail and nothing reaches the turns above it.
	let mut body = div()
		.flex()
		.flex_col()
		.justify_end()
		.w_full()
		.flex_1()
		.overflow_hidden()
		.px(tokens.spacing(SpacingStep::S4))
		.pt(tokens.spacing(SpacingStep::S4));

	body = if state.transcript.is_empty() {
		body.justify_center().child(opening_line(
			"What should this session do?",
			&surface.composer,
			tokens,
		))
	} else {
		body.child(transcript_column(
			&state.transcript,
			&surface.transcript,
			installed.user_turn_ground,
			tokens,
		))
	};

	div()
		.relative()
		.flex()
		.flex_col()
		.flex_1()
		.min_w_0()
		.h_full()
		.overflow_hidden()
		.gap(tokens.spacing(SpacingStep::S3))
		.pb(tokens.spacing(SpacingStep::S3))
		.child(body)
		.children((!state.cards.is_empty()).then(|| {
			// The stack shares the composer's measure and sits directly above
			// it, so a decision and the reply to it occupy one column.
			div()
				.w_full()
				.px(tokens.spacing(SpacingStep::S4))
				.flex()
				.flex_row()
				.justify_center()
				.child(div().w(px(widths.composer_px)).child(card_stack(
					&state.cards,
					&surface.attached_cards,
					tokens,
					cx,
				)))
		}))
		.child(
			div()
				.w_full()
				.px(tokens.spacing(SpacingStep::S4))
				.child(composer(
					&state.composed,
					widths.composer_px,
					widths.labels.footer,
					&surface.composer,
					tokens,
					cx,
				)),
		)
		.child(
			div()
				.w_full()
				.px(tokens.spacing(SpacingStep::S4))
				.child(run_bar(
					state.run_status.clone(),
					widths.composer_px,
					widths.labels.run_bar,
					&surface.composer,
					tokens,
				)),
		)
		// A docked drawer is the last row of the column, so the queue and the
		// right panel keep their full height beside it. An overlaid drawer
		// covers the column's lower edge instead, because below 980px the
		// transcript has no height left to give it (§5.7).
		.children((state.drawer_open && widths.drawer.placement == DrawerPlacement::Row).then(|| {
			terminal_drawer(&state.drawer_lines, widths.drawer.height_px, &surface.panels, tokens)
		}))
		.children((state.drawer_open && widths.drawer.placement == DrawerPlacement::Overlay).then(
			|| {
				div()
					.absolute()
					.bottom_0()
					.left_0()
					.right_0()
					.child(terminal_drawer(
						&state.drawer_lines,
						widths.drawer.height_px,
						&surface.panels,
						tokens,
					))
			},
		))
}
