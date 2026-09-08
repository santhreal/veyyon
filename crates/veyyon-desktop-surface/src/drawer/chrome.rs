//! Drawer header chrome and tab strip.
//!
//! Renders the 28px chrome row containing tenant tabs (terminals and process
//! supervisor), active title, palette search match count, and the vertical
//! resize drag affordance.

use veyyon_desktop_kit::{
	ColorRole, SpacingStep, TextRamp, TextWeight, TokenSet,
	controls::{Button, ButtonVariant},
	state::InteractiveState,
};
use veyyon_desktop_model::{SessionId, SurfaceId};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	ClickEvent, Context, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
	Styled, div, px,
};

use super::content::{DrawerContent, DrawerTab};
use crate::{
	Intent, ShellView,
	controls::{ControlStates, availability_style},
};
/// Builds the drawer chrome header bar.
pub fn drawer_chrome(
	content: &DrawerContent,
	controls: &ControlStates,
	session_id: u64,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let mut tabs_strip = div()
		.flex()
		.flex_row()
		.items_center()
		.gap(px(geometry.tabs_gap_px));

	if content.tabs.is_empty() {
		tabs_strip = tabs_strip.child(
			div()
				.h(px(geometry.tabs_height_px))
				.px(tokens.spacing(SpacingStep::S2))
				.flex()
				.items_center()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Secondary))
				.child("Terminal"),
		);
	} else {
		for (idx, tab) in content.tabs.iter().enumerate() {
			let is_active = idx == content.active_tab;
			let label = match tab {
				DrawerTab::Terminal { title, id } => {
					if title.is_empty() {
						format!("Terminal {id}")
					} else {
						title.clone()
					}
				},
				DrawerTab::Processes => "Processes".to_string(),
				DrawerTab::Process { name } => name.clone(),
			};
			// A process tab carries its name, so the click states which
			// process's output to follow rather than a strip position the
			// projection would have to reconstruct. Its request is gated like
			// every other control: a transport that cannot carry the
			// subscription leaves the tab visible and inert (§8.12).
			let (select, opacity) = match tab {
				DrawerTab::Process { name } => {
					let id =
						SurfaceId::ProcessLogsTab(SessionId::from(session_id.to_string()), name.clone());
					let (opacity, _, allowed) = availability_style(&controls.availability(&id), tokens);
					let intent = allowed.then(|| Intent::OpenProcessLogs(name.clone()));
					(intent, opacity)
				},
				DrawerTab::Terminal { .. } | DrawerTab::Processes => {
					(Some(Intent::SelectDrawerTab(idx)), 1.0)
				},
			};

			let mut tab_el = div()
				.h(px(geometry.tabs_height_px))
				.max_w(px(geometry.tabs_max_width_px))
				.px(tokens.spacing(SpacingStep::S2))
				.flex()
				.flex_row()
				.items_center()
				.cursor_pointer()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.font_weight(if is_active {
					tokens.font_weight(TextWeight::Semibold)
				} else {
					tokens.font_weight(TextWeight::Medium)
				})
				.text_color(if is_active {
					tokens.color(ColorRole::Foreground)
				} else {
					tokens.color(ColorRole::Secondary)
				})
				.id(("drawer-tab", idx))
				.opacity(opacity)
				.child(label);

			if let Some(intent) = select {
				tab_el = tab_el.on_click(cx.listener(move |view, _event: &ClickEvent, _window, cx| {
					view.dispatch(intent.clone(), cx);
				}));
			}

			if is_active {
				tab_el = tab_el
					.bg(tokens.color(ColorRole::Canvas))
					.border_b(px(2.0))
					.border_color(tokens.color(ColorRole::Accent));
			}

			tabs_strip = tabs_strip.child(tab_el);
		}
	}

	let mut right_side = div()
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2));

	if let Some(search) = &content.search {
		right_side = right_side.child(
			div()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child(format!("{} matches", search.match_count)),
		);
	}

	if let Some(DrawerTab::Terminal { id: active_term_id, .. }) =
		content.tabs.get(content.active_tab)
	{
		let sid = SessionId::from(session_id.to_string());
		let clear_av = controls
			.availability(&SurfaceId::TerminalClearButton(sid.clone(), active_term_id.clone()));
		let (clear_op, _, clear_allowed) = availability_style(&clear_av, tokens);
		let mut clear_btn = Button::new("Clear")
			.id("clear-terminal-btn")
			.variant(ButtonVariant::Ghost);
		if clear_allowed {
			clear_btn = clear_btn.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
				view.dispatch(Intent::ClearTerminal, cx);
			}));
		} else {
			clear_btn = clear_btn.state(InteractiveState::Disabled);
		}

		let restart_av = controls
			.availability(&SurfaceId::TerminalRestartButton(sid.clone(), active_term_id.clone()));
		let (restart_op, _, restart_allowed) = availability_style(&restart_av, tokens);
		let mut restart_btn = Button::new("Restart")
			.id("restart-terminal-btn")
			.variant(ButtonVariant::Ghost);
		if restart_allowed {
			restart_btn =
				restart_btn.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
					view.dispatch(Intent::RestartTerminal, cx);
				}));
		} else {
			restart_btn = restart_btn.state(InteractiveState::Disabled);
		}

		let close_av =
			controls.availability(&SurfaceId::TerminalCloseButton(sid, active_term_id.clone()));
		let (close_op, _, close_allowed) = availability_style(&close_av, tokens);
		let mut close_btn = Button::new("Close")
			.id("close-terminal-btn")
			.variant(ButtonVariant::Ghost);
		if close_allowed {
			close_btn = close_btn.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
				view.dispatch(Intent::CloseTerminal, cx);
			}));
		} else {
			close_btn = close_btn.state(InteractiveState::Disabled);
		}

		right_side = right_side
			.child(div().opacity(clear_op).child(clear_btn))
			.child(div().opacity(restart_op).child(restart_btn))
			.child(div().opacity(close_op).child(close_btn));
	} else if matches!(content.tabs.get(content.active_tab), Some(DrawerTab::Processes)) {
		let sid = SessionId::from(session_id.to_string());
		let start_av = controls.availability(&SurfaceId::ProcessStartButton(sid));
		let (start_op, _, start_allowed) = availability_style(&start_av, tokens);
		let mut start_btn = Button::new("Start")
			.id("process-start-btn")
			.variant(ButtonVariant::Ghost);
		if start_allowed {
			start_btn = start_btn.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
				view.dispatch(Intent::ProcessStart { command: String::new(), args: Vec::new() }, cx);
			}));
		} else {
			start_btn = start_btn.state(InteractiveState::Disabled);
		}
		right_side = right_side.child(div().opacity(start_op).child(start_btn));
	}

	div()
		.h(px(geometry.chrome_row_height_px))
		.w_full()
		.flex_shrink_0()
		.flex()
		.flex_row()
		.items_center()
		.justify_between()
		.px(tokens.spacing(SpacingStep::S3))
		.border_b(px(1.0))
		.border_color(tokens.color(ColorRole::Hairline))
		.child(tabs_strip)
		.child(
			div().flex_1().flex().justify_center().child(
				div()
					.h(px(geometry.chrome_resize_handle_line_px))
					.w(px(geometry.chrome_resize_handle_hit_px))
					.bg(tokens.color(ColorRole::Hairline)),
			),
		)
		.child(right_side)
}
