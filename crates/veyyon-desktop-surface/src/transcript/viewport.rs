//! Virtualized transcript viewport element (§5.2, §5.3, §8.25).
//!
//! Replaces clipping with a native GPUI variable-height virtualized list that
//! centers the 768px prose column, follows the tail when at the bottom,
//! preserves the scroll anchor during streaming revisions when scrolled up,
//! restores per-session scroll positions, and provides a scroll-to-end pill
//! when unfollowed.

use std::rc::Rc;

use veyyon_desktop_kit::{ButtonVariant, ColorRole, IconName, TokenSet, controls::Button};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{
	Context, Div, InteractiveElement, IntoElement, MouseButton, MouseDownEvent, ParentElement,
	Styled, Window, div, list, px,
};

use super::{
	copy::{TurnMenu, turn_at, turn_text},
	state::TranscriptViewportState,
	turn::render_turn,
};
use crate::{
	ShellView,
	damage::{LaidOut, Region},
	model::Turn,
};

/// Renders the virtualized transcript viewport into the session surface.
///
/// Features:
/// - Virtualized turn item generation using GPUI's native `List` element with
///   O(1) Rc snapshot.
/// - Anchored tail following at the bottom, automatically paused when reading
///   older history.
/// - Floating "Scroll to end" pill displayed when the live edge is unfollowed.
/// - Bottom content inset support to clear overlapping composer and card stack
///   overlays.
/// - Preservation of the 768px reading column and user/assistant visual
///   hierarchy.
/// - Live animation frame scheduling via `Window::request_animation_frame`
///   while streaming.
pub fn transcript_viewport(
	state: &TranscriptViewportState,
	geometry: &TranscriptSurfaceTokens,
	user_ground: ColorRole,
	tokens: &TokenSet,
	motion_tokens: &MotionTokens,
	reduced_motion: bool,
	laid_out: &LaidOut,
	measure_px: f32,
	bottom_inset_px: f32,
	window: &mut Window,
	cx: &Context<ShellView>,
) -> Div {
	let measure_px = geometry.column_width_px.min(measure_px);
	let now = cx.background_executor().now();

	let (caret_opacity, _) = state.sample_caret(now, motion_tokens, reduced_motion);

	// Schedule the next frame on Window while caret, scroll, or reveal animations
	// are active
	if state.is_animating(now, motion_tokens, reduced_motion) {
		let view = cx.weak_entity();
		window.on_next_frame(move |_window, app| {
			let _ = view.update(app, |_view, cx| cx.notify());
		});
	}

	let view = cx.weak_entity();
	let list_state = state.list_state();
	let state_for_items = state.clone();
	let geometry_copy = geometry.clone();
	let tokens_copy = tokens.clone();
	let motion_tokens_copy = motion_tokens.clone();
	let turns_snapshot: Rc<[Turn]> = state.turns_snapshot();
	let turns_len = turns_snapshot.len();
	let item_layout = laid_out.clone();

	let list_el = list(list_state, move |turn_ix, _window, _cx| {
		if let Some(turn) = turns_snapshot.get(turn_ix) {
			let is_last = turn_ix + 1 == turns_len;
			let mut turn_el = render_turn(
				turn_ix,
				turn,
				is_last,
				state_for_items.is_streaming(),
				caret_opacity,
				&state_for_items,
				&geometry_copy,
				user_ground,
				&tokens_copy,
				&motion_tokens_copy,
				reduced_motion,
				measure_px,
				&item_layout,
				Some(&view),
			);

			if turn_ix > 0 {
				turn_el = turn_el.mt(px(geometry_copy.turns_gap));
			}

			if is_last && bottom_inset_px > 0.0 {
				turn_el = turn_el.pb(px(bottom_inset_px));
			}

			let row = div()
				.flex()
				.flex_row()
				.justify_center()
				.w_full()
				.child(div().w_full().max_w(px(measure_px)).child(turn_el));
			item_layout
				.track_children(row, move |index| (index == 0).then_some(Region::Turn(turn_ix)))
				.into_any_element()
		} else {
			div().into_any_element()
		}
	})
	.w_full()
	.h_full();

	let focus = state.focus_handle(cx);
	// The right-click is taken by the body rather than by each turn, so the
	// transcript costs one hit rect however many turns it holds, and the turn
	// under the pointer is resolved from the boxes the last frame laid out
	// (§5.3).
	let menu_turns: Rc<[Turn]> = state.turns_snapshot();
	let menu_layout = laid_out.clone();
	let menu_view = cx.weak_entity();
	let mut container = div()
		.track_focus(&focus)
		.on_mouse_down(MouseButton::Left, move |_, window, app| window.focus(&focus, app))
		.on_mouse_down(MouseButton::Right, move |event: &MouseDownEvent, _window, app| {
			let Some(turn) = turn_at(&menu_layout, menu_turns.len(), event.position) else {
				return;
			};
			let Some(drawn) = menu_turns.get(turn) else {
				return;
			};
			let text = turn_text(drawn);
			let forkable = matches!(drawn, Turn::Operator(_) | Turn::OperatorArtifacts { .. });
			let _ = menu_view.update(app, |view, cx| {
				view.open_turn_menu(TurnMenu { turn, origin: event.position, text, forkable });
				cx.notify();
			});
		})
		.relative()
		.flex()
		.flex_col()
		.w_full()
		.h_full()
		.overflow_hidden()
		.child(list_el);

	// Floating "Scroll to end" pill, drawn only while the end is off screen
	// (§5.3). It used to be drawn from tail following alone, which the turn
	// cursor also stops: stepping back through a transcript that fits its
	// viewport raised the pill over prose whose last row was already visible,
	// and the jump it offered moved nothing.
	if state.is_end_off_screen() && turns_len > 0 {
		let state_scroll = state.clone();
		let view_scroll = cx.weak_entity();
		let motion_scroll = motion_tokens.clone();
		let pill_bottom = bottom_inset_px + 12.0;

		let pill = div()
			.absolute()
			.bottom(px(pill_bottom))
			.left_0()
			.right_0()
			.flex()
			.flex_row()
			.justify_center()
			.child(
				Button::new("transcript-scroll-to-end", "Scroll to end")
					.variant(ButtonVariant::Primary)
					.size(veyyon_desktop_kit::controls::button::ButtonSize::Small)
					.leading_icon(IconName::ChevronDown)
					.on_click(move |_event, _window, cx| {
						state_scroll.scroll_to_end_animated(
							&motion_scroll,
							reduced_motion,
							std::time::Instant::now(),
						);
						let _ = view_scroll.update(cx, |_view, cx| cx.notify());
					}),
			);

		container = container.child(pill);
	}

	container
}
