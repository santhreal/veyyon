//! Tool invocation block renderer (§5.2, §5.3).
//!
//! Renders tool invocations collapsed to a 24px interactive line, expanding to
//! target and result details with animated height reveal and width-bounded
//! summaries.

use std::time::Instant;

use veyyon_desktop_kit::{
	CodeBlock, ColorRole, Icon, IconName, IconSize, MonoSizeStep, MonoText, SpacingStep, TextRamp,
	TextWeight, TokenSet, Truncate,
	controls::button::{Button, ButtonSize},
};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{
	App, CursorStyle, Div, InteractiveElement, ParentElement, SharedString, Styled, WeakEntity, div,
	px,
};

use super::reveal::render_reveal_container;
use crate::{
	Intent, ShellView,
	model::ToolInvocationViews,
	tool_view::{ToolViewCallbacks, render_tool_view, render_tool_view_row},
	transcript::state::TranscriptViewportState,
};

/// Sends an intent through the shell that owns this block, if one is attached.
fn dispatch_to_shell(view: Option<&WeakEntity<ShellView>>, intent: Intent, cx: &mut App) {
	if let Some(shell) = view {
		let _ = shell.update(cx, |shell, cx| shell.dispatch(intent, cx));
	}
}

/// Disclosure and target callbacks for a host-supplied view of one call.
fn view_callbacks(
	call_id: &str,
	turn_ix: usize,
	block_ix: usize,
	viewport_state: &TranscriptViewportState,
	motion_tokens: &MotionTokens,
	reduced_motion: bool,
	view: Option<&WeakEntity<ShellView>>,
) -> ToolViewCallbacks {
	let disclose_view = view.cloned();
	let disclose_state = viewport_state.clone();
	let disclose_motion = motion_tokens.clone();
	let disclose_id = call_id.to_owned();
	let target_view = view.cloned();
	ToolViewCallbacks::new()
		.on_disclose(move |_window, cx| {
			disclose_state.set_block_expanded(
				turn_ix,
				block_ix,
				true,
				&disclose_motion,
				reduced_motion,
				Instant::now(),
			);
			dispatch_to_shell(
				disclose_view.as_ref(),
				Intent::SetToolViewExpanded { call_id: disclose_id.clone(), expanded: true },
				cx,
			);
		})
		.on_target(move |target, _window, cx| {
			dispatch_to_shell(target_view.as_ref(), Intent::OpenToolTarget(target), cx);
		})
}

/// Tool invocation block, collapsed to a 24px interactive line, expanding to
/// parameter and result details.
pub fn render_invoke_block(
	turn_ix: usize,
	block_ix: usize,
	call_id: &str,
	tool: &str,
	target: &str,
	result: Option<&str>,
	views: &ToolInvocationViews,
	is_expanded: bool,
	geometry: &TranscriptSurfaceTokens,
	tokens: &TokenSet,
	motion_tokens: &MotionTokens,
	reduced_motion: bool,
	viewport_state: &TranscriptViewportState,
	view: Option<&WeakEntity<ShellView>>,
) -> Div {
	let chevron = if is_expanded {
		IconName::ChevronDown
	} else {
		IconName::ChevronRight
	};

	let state_toggle = viewport_state.clone();
	let state_collapse = viewport_state.clone();
	let motion_tokens_toggle = motion_tokens.clone();
	let motion_tokens_collapse = motion_tokens.clone();
	let view_toggle = view.cloned();
	let view_collapse = view.cloned();
	// The result's view supersedes the call's: a settled card states what
	// happened, and the host regenerates the call half with `hasResult` set, so
	// the two halves never state the same output twice.
	let presentation = views.result.as_ref().or(views.call.as_ref());
	let callbacks = presentation.map(|_| {
		view_callbacks(
			call_id,
			turn_ix,
			block_ix,
			viewport_state,
			motion_tokens,
			reduced_motion,
			view,
		)
	});
	let toggles_host_view = presentation.is_some();
	let toggle_view = view.cloned();
	let toggle_id = call_id.to_owned();
	let collapse_view = view.cloned();
	let collapse_id = call_id.to_owned();
	let next_expanded = !is_expanded;

	// The collapsed card is the transcript's own collapsed chrome height, and it
	// clips: a host view is a whole card, and one drawn at its natural height
	// inside this row spilled over the blocks above and below it. The event line
	// height this used to state is the height of one line INSIDE a pane, which
	// is half a row, so even a status row overflowed it.
	let mut header = div()
		.h(px(geometry.chrome_collapsed_height_px))
		.w_full()
		.flex()
		.flex_row()
		.items_center()
		.overflow_hidden()
		.gap(tokens.spacing(SpacingStep::S2))
		.cursor(CursorStyle::PointingHand)
		.on_mouse_down(veyyon_gpui::MouseButton::Left, move |_event, _window, cx| {
			state_toggle.toggle_block_expanded(
				turn_ix,
				block_ix,
				&motion_tokens_toggle,
				reduced_motion,
				Instant::now(),
			);
			if toggles_host_view {
				dispatch_to_shell(
					toggle_view.as_ref(),
					Intent::SetToolViewExpanded { call_id: toggle_id.clone(), expanded: next_expanded },
					cx,
				);
			} else if let Some(v) = &view_toggle {
				let _ = v.update(cx, |_view, cx| cx.notify());
			}
		})
		.child(
			div().flex_shrink_0().child(
				Icon::new(chevron)
					.size(IconSize::Size12)
					.color(tokens.color(ColorRole::Muted)),
			),
		)
		.child(
			div()
				.flex_shrink_0()
				.mono_text(tokens, MonoSizeStep::Small)
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(tool.to_owned()),
		)
		.child(
			div()
				.flex_1()
				.min_w_0()
				.child(match (presentation, callbacks.as_ref()) {
					// A host-supplied view IS the row's subject, so the recorded target
					// and the result's first line are not restated beside it. The row
					// takes the view's one-line projection; the card below takes the
					// view itself, and while it is open the row states nothing held
					// back, since the card is showing every line of it.
					(Some(presentation), Some(callbacks)) => {
						render_tool_view_row(&presentation.view, tokens, callbacks, !is_expanded)
					},
					_ => div().child(
						Truncate::new(target.to_owned())
							.mono(MonoSizeStep::Small)
							.color(ColorRole::Secondary),
					),
				}),
		);

	if presentation.is_none() {
		if let Some(res) = result {
			let summary = res.lines().next().unwrap_or("").trim();
			header = header.child(
				div().flex_shrink_0().max_w(px(240.0)).min_w_0().child(
					Truncate::new(summary.to_owned())
						.ramp(TextRamp::Micro)
						.color(ColorRole::Muted),
				),
			);
		} else if viewport_state.is_streaming() && turn_ix + 1 == viewport_state.turn_count() {
			header = header.child(
				div()
					.flex_shrink_0()
					.text_size(tokens.font_size(TextRamp::Micro))
					.line_height(tokens.line_height(TextRamp::Micro))
					.text_color(tokens.color(ColorRole::Accent))
					.child("Running..."),
			);
		}
	}

	let mut container = div().flex().flex_col().w_full().child(header);

	let mut details = div()
		.flex()
		.flex_col()
		.w_full()
		.mt(px(4.0))
		.p(tokens.spacing(SpacingStep::S2))
		.bg(tokens.color(ColorRole::Canvas))
		.rounded_md()
		.border_1()
		.border_color(tokens.color(ColorRole::Hairline))
		.gap(tokens.spacing(SpacingStep::S2));

	if let (Some(presentation), Some(callbacks)) = (presentation, callbacks.as_ref()) {
		let line_height = geometry.chrome_event_line_height_px.max(1.0);
		let rows = (geometry.chrome_invoke_mono_pane_max_height_px / line_height) as usize;
		details =
			details.child(render_tool_view(&presentation.view, tokens, Some(rows.max(1)), callbacks));
	} else {
		if !target.is_empty() {
			details = details.child(
				div()
					.mono_text(tokens, MonoSizeStep::Small)
					.text_color(tokens.color(ColorRole::Secondary))
					.child(format!("Target: {target}")),
			);
		}

		if let Some(res) = result {
			let lines: Vec<SharedString> = res
				.lines()
				.map(|l| SharedString::from(l.to_owned()))
				.collect();
			details = details.child(
				CodeBlock::lines(lines)
					.caption("Output")
					.size(MonoSizeStep::Small)
					.max_height(px(geometry.chrome_invoke_mono_pane_max_height_px)),
			);
		}
	}

	details = details.child(
		div().flex().justify_end().w_full().child(
			Button::new("Collapse")
				.size(ButtonSize::Small)
				.on_click(move |_event, _window, cx| {
					state_collapse.set_block_expanded(
						turn_ix,
						block_ix,
						false,
						&motion_tokens_collapse,
						reduced_motion,
						Instant::now(),
					);
					if toggles_host_view {
						dispatch_to_shell(
							collapse_view.as_ref(),
							Intent::SetToolViewExpanded { call_id: collapse_id.clone(), expanded: false },
							cx,
						);
					} else if let Some(v) = &view_collapse {
						let _ = v.update(cx, |_view, cx| cx.notify());
					}
				}),
		),
	);

	if let Some(revealed) =
		render_reveal_container(turn_ix, block_ix, is_expanded, viewport_state, view, details)
	{
		container = container.child(revealed);
	}

	container
}
