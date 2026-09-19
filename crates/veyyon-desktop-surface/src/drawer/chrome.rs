//! Drawer header chrome and tab strip.
//!
//! Renders the chrome row containing tenant tabs (terminals and process
//! supervisor), active title, palette search match count, and the tab
//! actions. The drawer's resize grip is the split's own handle, above this
//! row, not a mark painted inside it.

use veyyon_desktop_kit::{
	ColorRole, SpacingStep, StrokeStep, TextRamp, TextWeight, TokenSet,
	controls::{Button, ButtonVariant},
	overlays::Tooltip,
	state::InteractiveState,
};
use veyyon_desktop_model::{SessionId, SurfaceId, TerminalStatus};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, ElementId, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, Window, div, px,
};

use super::content::{DrawerContent, DrawerTab};
use crate::{
	Intent, ShellView,
	controls::{Availability, ControlStates, availability_style},
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
			let (label, is_exited, is_failed) = match tab {
				DrawerTab::Terminal { title, id, status } => {
					let base = if title.is_empty() {
						format!("Terminal {id}")
					} else {
						title.clone()
					};
					match status {
						TerminalStatus::Running => (base, false, false),
						TerminalStatus::Exited { code } => {
							let tag = if *code == 0 {
								" (exited)".to_string()
							} else {
								format!(" (exit {code})")
							};
							(format!("{base}{tag}"), true, false)
						},
						TerminalStatus::Failed { .. } => (format!("{base} (failed)"), false, true),
					}
				},
				DrawerTab::Processes => ("Processes".to_string(), false, false),
				DrawerTab::Process { name } => (name.clone(), false, false),
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
					let av = controls.availability(&id);
					let (opacity, _, allowed) = availability_style(&av, tokens);
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
				} else if is_failed {
					tokens.color(ColorRole::ErrorFill)
				} else if is_exited {
					tokens.color(ColorRole::Muted)
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
					.border_b(tokens.stroke(StrokeStep::Heavy))
					.border_color(tokens.color(ColorRole::Accent));
			} else {
				tab_el = tab_el.hover(|s| {
					s.bg(tokens.color(ColorRole::Inset))
						.text_color(tokens.color(ColorRole::Foreground))
				});
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

	// The attach-or-create the drawer's opening runs happens once, so closing
	// the last terminal left the drawer with no route to another: an empty
	// strip captioned `Terminal` with nothing on it to press, or, where the
	// host supervises processes, the process list and its `Start`. `New` is
	// the route back, and it is drawn wherever the strip holds no terminal: a
	// strip that holds one is at the five interactive elements §6.6 authors
	// for this row, and has a terminal to work with.
	if !content
		.tabs
		.iter()
		.any(|tab| matches!(tab, DrawerTab::Terminal { .. }))
	{
		let create_id = SurfaceId::TerminalCreateButton(SessionId::from(session_id.to_string()));
		let create_av = controls.availability(&create_id);
		let new_btn = action_button(
			"new-terminal-btn",
			"New",
			&create_av,
			tokens,
			cx,
			|view, _event, _window, cx| {
				view.dispatch(Intent::NewTerminal, cx);
			},
		);
		right_side = right_side.child(new_btn);
	}

	if let Some(DrawerTab::Terminal { id: active_term_id, .. }) =
		content.tabs.get(content.active_tab)
	{
		let sid = SessionId::from(session_id.to_string());
		let clear_av = controls
			.availability(&SurfaceId::TerminalClearButton(sid.clone(), active_term_id.clone()));
		let clear_btn = action_button(
			"clear-terminal-btn",
			"Clear",
			&clear_av,
			tokens,
			cx,
			|view, _event, _window, cx| {
				view.dispatch(Intent::ClearTerminal, cx);
			},
		);

		let restart_av = controls
			.availability(&SurfaceId::TerminalRestartButton(sid.clone(), active_term_id.clone()));
		let restart_btn = action_button(
			"restart-terminal-btn",
			"Restart",
			&restart_av,
			tokens,
			cx,
			|view, _event, _window, cx| {
				view.dispatch(Intent::RestartTerminal, cx);
			},
		);

		let close_av =
			controls.availability(&SurfaceId::TerminalCloseButton(sid, active_term_id.clone()));
		let close_btn = action_button(
			"close-terminal-btn",
			"Close",
			&close_av,
			tokens,
			cx,
			|view, _event, _window, cx| {
				view.dispatch(Intent::CloseTerminal, cx);
			},
		);

		right_side = right_side
			.child(clear_btn)
			.child(restart_btn)
			.child(close_btn);
	} else if matches!(content.tabs.get(content.active_tab), Some(DrawerTab::Processes)) {
		let sid = SessionId::from(session_id.to_string());
		let start_av = controls.availability(&SurfaceId::ProcessStartButton(sid));
		let start_btn = action_button(
			"process-start-btn",
			"Start",
			&start_av,
			tokens,
			cx,
			|view, _event, _window, cx| {
				view.submit_process_command(cx);
			},
		);
		right_side = right_side.child(start_btn);
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
		.border_b(tokens.stroke(StrokeStep::Hairline))
		.border_color(tokens.color(ColorRole::Hairline))
		.child(tabs_strip)
		.child(right_side)
}
/// Renders an action strip button with availability-aware opacity and
/// interaction (§4.3).
fn action_button(
	id: impl Into<ElementId>,
	label: &'static str,
	av: &Availability,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
	on_click: impl Fn(&mut ShellView, &ClickEvent, &mut Window, &mut Context<ShellView>) + 'static,
) -> AnyElement {
	let mut btn = Button::new(id, label).variant(ButtonVariant::Ghost);
	match av {
		Availability::Enabled | Availability::Unknown => {
			btn = btn.on_click(cx.listener(on_click));
			btn.into_any_element()
		},
		Availability::Pending => {
			// §4.3: Pending renders in place at the authored pending strength,
			// activation suppressed, no spinner under 400ms.
			// InteractiveState::Disabled is not set here, because it applies
			// the unavailable strength and would compound with this one.
			div()
				.opacity(tokens.gate().pending)
				.child(btn)
				.into_any_element()
		},
		Availability::Unavailable { reason } => {
			// §4.3: Unavailable muted with the reason readable at the control.
			// Button::state(InteractiveState::Disabled) resolves the muted
			// strength through ControlMetrics::disabled_opacity.
			btn = btn.state(InteractiveState::Disabled);
			if reason.is_empty() {
				btn.into_any_element()
			} else {
				Tooltip::new(reason.clone(), btn).above().into_any_element()
			}
		},
	}
}
