//! The middle column: transcript, attached cards, composer, run bar, drawer.
//!
//! The column is the surface being read, so it is the one region that takes
//! whatever width the queue and the right panel leave. Everything in it shares
//! the composer's measure, so a decision, the reply to it and the line stating
//! what the session is doing all sit in one column rather than three.

use std::{cell::Cell, rc::Rc};

use veyyon_desktop_kit::{Axis, ColorRole, Resizable, SpacingStep, TextSelection, input::Editor};
use veyyon_desktop_tokens::DrawerPlacement;
use veyyon_gpui::{
	Context, Div, Entity, FocusHandle, InteractiveElement, MouseButton, ParentElement, Pixels,
	Point, Styled, Window, div, point, px,
};

use super::{keys::bind_composer_keys, session_error::session_error_strip};
use crate::{
	ShellView,
	cards::card_stack,
	composer::{ComposerLocal, MIN_COMPOSER_WIDTH_PX, composer, opening_line, run_bar},
	damage::{LaidOut, Region},
	drawer::{SupervisorFields, terminal_drawer},
	layout::ShellWidths,
	model::ShellState,
	tokens::InstalledTokens,
	transcript::{TranscriptViewportState, transcript_viewport},
};

/// Builds the session surface for the state and the resolved widths.
///
/// The box of every region in the column is recorded in `laid_out` as the
/// column is prepainted, so a change confined to one region repaints that
/// region alone (P5).
pub fn session_surface(
	state: &ShellState,
	editor: Option<&Entity<Editor>>,
	supervisor: SupervisorFields<'_>,
	local: ComposerLocal<'_>,
	has_text: bool,
	widths: &ShellWidths,
	installed: &InstalledTokens,
	laid_out: &LaidOut,
	palette_anchor: Rc<Cell<Point<Pixels>>>,
	viewport: &TranscriptViewportState,
	transcript_focus: &FocusHandle,
	cards_focus: &FocusHandle,
	cards_expanded: bool,
	reduced_motion: bool,
	find_bar: Option<Div>,
	selection: Option<TextSelection>,
	panel_overlay: Option<Div>,
	window: &mut Window,
	cx: &Context<ShellView>,
) -> Div {
	let tokens = &installed.set;
	let is_focused = editor.is_some_and(|ed| ed.read(cx).focus_handle().is_focused(window));
	let mut local = local;
	local.focused = is_focused || local.focused;
	let clamped_composer_px = widths.composer_px.max(MIN_COMPOSER_WIDTH_PX);
	let composer_width = px(clamped_composer_px);
	let surface = &installed.surface;

	let has_transcript = !state.transcript.is_empty();
	let body = if has_transcript {
		div()
			.key_context("Transcript")
			.track_focus(transcript_focus)
			.flex()
			.flex_col()
			.justify_end()
			.w_full()
			.flex_1()
			.overflow_hidden()
			.px(tokens.spacing(SpacingStep::S4))
			.pt(tokens.spacing(SpacingStep::S4))
			// The same inset below: the composer's lit rim is drawn outside its
			// border box, so a transcript that ended at the column's gap put
			// the glow on the descenders of its last line.
			.pb(tokens.spacing(SpacingStep::S4))
			.child(transcript_viewport(
				viewport,
				&surface.transcript,
				installed.user_turn_ground,
				tokens,
				&installed.motion,
				reduced_motion,
				laid_out,
				widths.session_px,
				0.0,
				selection,
				window,
				cx,
			))
	} else {
		div()
	};

	// An overlaid right panel dims the region it annotates: the transcript it
	// was opened against. The composer keeps its light, the cards above it
	// stay legible, and a press in either still reaches them (§5.6). The
	// float's own box is recorded from in here, because the scrim it sits in
	// spans this region rather than the columns row.
	let body = match panel_overlay {
		None => body,
		Some(float) => div()
			.relative()
			.flex()
			.flex_col()
			.w_full()
			.flex_1()
			.min_w_0()
			.overflow_hidden()
			.child(body)
			.child(float),
	};

	// The name of every child this column takes, in the order the children are
	// appended, so a box is read back by position. A child is recorded where it
	// is added, and `None` marks one no region names -- the error strip, an
	// empty-state line, the find bar. A name pushed under a condition that
	// does not match the child's shifts every name after it: the transcript's
	// box is then read as the cards', the cards' as the composer's, and a
	// press, a float and a scroll all resolve against a surface that is
	// somewhere else.
	let mut regions: Vec<Option<Region>> = Vec::new();

	// A press inside the composer's box that missed the editor's own text area
	// — the padding around it, the row of controls under it, the button that
	// was pressed — left the draft blurred: the keyboard went nowhere, the
	// next keystroke was dropped on the floor, and the composer's own chords
	// stopped resolving because the `Composer` context left the focus path.
	// The box hands the keyboard back to the editor whatever the press landed
	// on (§5.4).
	//
	// It captures rather than bubbles: a control that answers the press stops
	// propagation, and a bubble listener above it never runs. A control that
	// wants the focus for itself still takes it, because it runs after this.
	let composer_input = match editor {
		Some(editor) => {
			let focus = editor.read(cx).focus_handle().clone();
			div()
				.key_context("Composer")
				.capture_any_mouse_down(move |event, window, app| {
					if event.button == MouseButton::Left {
						window.focus(&focus, app);
						// gpui transfers focus to every focusable element under
						// the pointer during the bubble phase, and the window
						// root is focusable: without this the root takes the
						// keyboard back one phase later and the draft is blurred
						// by a press on its own controls.
						window.prevent_default();
					}
				})
		},
		None => div().key_context("Composer"),
	};

	let mut column = div()
		.relative()
		.flex()
		.flex_col()
		.flex_1()
		.min_w_0()
		.h_full()
		.bg(tokens.color(ColorRole::Canvas))
		.overflow_hidden()
		.gap(tokens.spacing(SpacingStep::S3))
		.pb(tokens.spacing(SpacingStep::S3));
	let session_error = if state.current_id > 0 {
		let sid = veyyon_desktop_model::SessionId::from(state.current_id.to_string());
		state
			.controls
			.error(&veyyon_desktop_model::SurfaceId::ComposerSendButton(sid.clone()))
			.or_else(|| {
				state
					.controls
					.error(&veyyon_desktop_model::SurfaceId::QueueSessionRow(sid))
			})
	} else {
		None
	};
	if let Some(err) = session_error {
		column = column.child(session_error_strip(err, composer_width, tokens));
		regions.push(None);
	}

	// A transcript that holds turns is the content this region exists to draw,
	// whether or not a session id has been assigned yet: an attached surface
	// replaying turns has something to show, so the first-run line would hide
	// it. The empty states below are reached only when there is no transcript,
	// which keeps `regions` -- which records `Region::Transcript` for exactly
	// this child -- naming the box that was actually drawn.
	if has_transcript {
		column = column.child(body);
		regions.push(Some(Region::Transcript));
	} else if state.current_id == 0 {
		column = column.justify_center().child(
			div()
				.w_full()
				.px(tokens.spacing(SpacingStep::S4))
				.flex()
				.flex_row()
				.justify_center()
				.child(opening_line("Create a session to begin", &surface.composer, tokens)),
		);
		regions.push(None);
	} else {
		column = column.justify_center().child(
			div()
				.w_full()
				.px(tokens.spacing(SpacingStep::S4))
				.flex()
				.flex_row()
				.justify_center()
				.child(opening_line("What should this session do?", &surface.composer, tokens)),
		);
		regions.push(None);
	}

	if !state.cards.is_empty() {
		// The stack shares the composer's measure and sits directly above it,
		// so a decision and the reply to it occupy one column.
		column = column.child(
			div()
				.w_full()
				.px(tokens.spacing(SpacingStep::S4))
				.flex()
				.flex_row()
				.justify_center()
				.child(div().w(composer_width).child(card_stack(
					&state.cards,
					&state.card_answers,
					&surface.attached_cards,
					tokens,
					cards_focus,
					cards_expanded,
					cx,
				))),
		);
		regions.push(Some(Region::Cards));
	}

	column = column.child(bind_composer_keys(
		composer_input
			.w_full()
			.px(tokens.spacing(SpacingStep::S4))
			.on_children_prepainted(move |children, _window, _cx| {
				if let Some(bounds) = children.first() {
					palette_anchor.set(point(
						bounds.origin.x + (bounds.size.width - composer_width) / 2.0,
						bounds.origin.y,
					));
				}
			})
			.child(composer(
				editor,
				&state.turn,
				&state.composer,
				local,
				has_text,
				state.current_id,
				widths.composer_px,
				widths.labels.footer,
				&state.controls,
				&surface.composer,
				tokens,
				cx,
			)),
		cx,
	));
	regions.push(Some(Region::Composer));

	column = column.child(
		div()
			.w_full()
			.px(tokens.spacing(SpacingStep::S4))
			.child(run_bar(
				state.run_status.clone(),
				clamped_composer_px,
				widths.labels.run_bar,
				state.turn.is_stoppable(),
				state.current_id,
				&state.controls,
				&surface.composer,
				tokens,
				cx,
			)),
	);
	regions.push(Some(Region::RunBar));

	// The drawer is a child here only where it is drawn over the session. In
	// the row placement it is the column's sibling below, tracked from there,
	// so nothing is recorded for it in this list.
	if state.drawer_open
		&& state.drawer.offered
		&& widths.drawer.placement == DrawerPlacement::Overlay
	{
		column = column.child(
			div()
				.absolute()
				.bottom_0()
				.left_0()
				.right_0()
				.child(terminal_drawer(
					&state.drawer,
					DrawerPlacement::Overlay,
					widths.drawer.height_px,
					&state.controls,
					state.current_id,
					supervisor,
					&surface.panels,
					tokens,
					laid_out,
					cx,
				)),
		);
		regions.push(Some(Region::Drawer));
	}

	if let Some(bar) = find_bar {
		column = column.child(
			div()
				.absolute()
				.top(tokens.spacing(SpacingStep::S4))
				.right(tokens.spacing(SpacingStep::S4))
				.child(bar),
		);
		regions.push(None);
	}

	let column = laid_out.track_children(column, move |index| regions.get(index).copied().flatten());
	if state.drawer_open && state.drawer.offered && widths.drawer.placement == DrawerPlacement::Row {
		let extent = widths.columns_px.max(1.0);
		let maximum = extent * surface.panels.terminal_drawer_max_viewport_ratio;
		let minimum = surface.panels.terminal_drawer_min_height_px.min(maximum);
		let grip = surface.panels.chrome_resize_handle_hit_px;
		let drawer = terminal_drawer(
			&state.drawer,
			DrawerPlacement::Row,
			(widths.drawer.height_px - grip).max(0.0),
			&state.controls,
			state.current_id,
			supervisor,
			&surface.panels,
			tokens,
			laid_out,
			cx,
		);
		let drawer = laid_out.track_children(div().w_full().h_full().child(drawer), |index| {
			(index == 0).then_some(Region::Drawer)
		});
		let shell = cx.weak_entity();
		let release_shell = shell.clone();
		div().flex().flex_1().min_w_0().h_full().child(
			Resizable::new("session-drawer-split", Axis::Vertical, px(grip), column, drawer)
				.ratio((extent - widths.drawer.height_px) / extent)
				.on_resize(move |ratio, _window, cx| {
					let _ = shell.update(cx, |view, cx| {
						view.drag_drawer((1.0 - ratio) * extent, minimum, maximum, cx);
						cx.notify();
					});
				})
				.on_resize_end(move |_window, cx| {
					let _ = release_shell.update(cx, |view, cx| {
						view.release_drawer(cx);
						cx.notify();
					});
				}),
		)
	} else {
		column
	}
}
