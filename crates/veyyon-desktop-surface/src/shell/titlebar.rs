//! Window titlebar chrome and the attention strip (§4.1).
//!
//! The titlebar carries four things: the queue rail control, the open
//! session's name, the connection state, and the right panel and drawer
//! controls. Window controls are the platform's: macOS draws its traffic
//! lights into the inset this bar leaves for them, and elsewhere the window
//! manager's own decorations sit above the bar.

use veyyon_desktop_kit::{
	ColorRole, Dot, IconButton, IconButtonVariant, IconName, IconSize, RadiusStep, SpacingStep,
	Spinner, SpinnerSize, StrokeStep, TextRamp, TextWeight, TokenSet,
	input::{Editor, TextField},
};
use veyyon_desktop_tokens::ShellSurfaceTokens;
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, CursorStyle, Div, ElementId, Entity, InteractiveElement,
	IntoElement, MouseMoveEvent, ParentElement, StatefulInteractiveElement, Styled, div, px,
};

use crate::{
	Intent, ShellView,
	attach::ConnectionPhase,
	menu::MenuState,
	shell::menu::{MenuAnchors, menu_bar},
};

/// The room macOS traffic lights take at the bar's left edge when the window
/// draws its own titlebar (§4.1). Other platforms draw their controls outside
/// the bar, so they take nothing from it.
#[must_use]
pub const fn platform_inset_left_px() -> f32 {
	if cfg!(target_os = "macos") { 78.0 } else { 0.0 }
}

/// What the titlebar shows, read from the shell's state.
#[derive(Debug, Clone)]
pub struct TitlebarState<'a> {
	pub title:            &'a str,
	pub rename_editor:    Option<Entity<Editor>>,
	pub connection:       &'a ConnectionPhase,
	pub queue_collapsed:  bool,
	/// Whether there is a panel to show; the control is hidden without one.
	pub panel_available:  bool,
	pub panel_collapsed:  bool,
	/// Whether there is a drawer to show; the control is hidden without one.
	pub drawer_available: bool,
	pub drawer_open:      bool,
	pub menu:             &'a MenuState,
	pub menu_anchors:     MenuAnchors,
}

/// The titlebar: the rail control, the open session's name, the connection
/// state, the panel and drawer controls.
///
/// Dragging an empty part of the bar moves the window and a double click
/// zooms it, which is what a bar with no native decoration owes the platform.
pub fn titlebar(
	state: TitlebarState<'_>,
	geometry: &ShellSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let gap = px(geometry.titlebar_control_gap_px);

	let leading = div()
		.flex()
		.flex_row()
		.items_center()
		.flex_shrink_0()
		.gap(gap)
		.child(toggle_control(
			"titlebar-queue",
			IconName::PanelLeft,
			!state.queue_collapsed,
			geometry.titlebar_control_px,
			cx,
			|view, cx| {
				view.toggle_queue(cx);
			},
		))
		.child(menu_bar(state.menu, state.menu_anchors, tokens, cx));
	let mut trailing = div()
		.flex()
		.flex_row()
		.items_center()
		.flex_shrink_0()
		.gap(gap)
		.child(connection_state(state.connection, tokens));
	if state.panel_available {
		trailing = trailing.child(toggle_control(
			"titlebar-panel",
			IconName::PanelRight,
			!state.panel_collapsed,
			geometry.titlebar_control_px,
			cx,
			|view, cx| {
				let open = view.state().keymap.panel_collapsed;
				view.dispatch(Intent::SetPanel { open }, cx);
			},
		));
	}
	if state.drawer_available {
		trailing = trailing.child(toggle_control(
			"titlebar-drawer",
			IconName::Terminal,
			state.drawer_open,
			geometry.titlebar_control_px,
			cx,
			|view, cx| {
				let open = !view.state().drawer_open;
				view.dispatch(Intent::SetDrawer { open }, cx);
			},
		));
	}
	let center = div()
		.flex_1()
		.min_w_0()
		.flex()
		.flex_row()
		.justify_center()
		.items_center()
		.child(if let Some(editor) = state.rename_editor {
			div()
				.id("titlebar-title-edit")
				.w_full()
				.max_w(px(geometry.titlebar_rename_width_px))
				.child(TextField::new("session-rename-field", editor))
		} else {
			div()
				.id("titlebar-title")
				.w_full()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.text_center()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Secondary))
				.on_click(cx.listener(|view, event: &ClickEvent, window, cx| {
					if event.click_count() == 2 {
						cx.stop_propagation();
						view.open_session_rename(window, cx);
					}
				}))
				.child(state.title.to_owned())
		});

	div()
		.id("titlebar")
		.h(px(geometry.titlebar_height_px))
		.w_full()
		.flex_shrink_0()
		.bg(tokens.color(ColorRole::Rail))
		.flex()
		.flex_row()
		.items_center()
		.pl(px(geometry.titlebar_inset_left_px + platform_inset_left_px()))
		.pr(px(geometry.titlebar_inset_right_px))
		.border_b(tokens.stroke(StrokeStep::Hairline))
		.border_color(tokens.color(ColorRole::Hairline))
		.overflow_hidden()
		.on_mouse_move(|event: &MouseMoveEvent, window, _cx| {
			if event.dragging() {
				window.start_window_move();
			}
		})
		.on_click(|event: &ClickEvent, window, _cx| {
			if event.click_count() == 2 {
				window.zoom_window();
			}
		})
		.child(leading)
		.child(center)
		.child(trailing)
}

/// One titlebar control: ink alone at rest, the selected wash while what it
/// controls is shown, the hover wash under the pointer.
fn toggle_control(
	id: &'static str,
	icon: IconName,
	shown: bool,
	control_px: f32,
	cx: &Context<ShellView>,
	on_click: impl Fn(&mut ShellView, &mut Context<ShellView>) + 'static,
) -> impl IntoElement {
	let variant = if shown {
		IconButtonVariant::Subtle
	} else {
		IconButtonVariant::Ghost
	};
	div()
		.w(px(control_px))
		.h(px(control_px))
		.flex()
		.items_center()
		.justify_center()
		.flex_shrink_0()
		.child(
			IconButton::new(id, icon)
				.size(IconSize::Size14)
				.variant(variant)
				.on_click(cx.listener(move |view, _event: &ClickEvent, _window, cx| {
					on_click(view, cx);
				})),
		)
}

/// The connection state as a mark, with a word beside it only while something
/// is not settled: a bar that says "Connected" all day is a bar nobody reads.
/// A phase that is waiting on the host draws a spinner; one that has landed
/// draws a dot in the ink of where it landed.
fn connection_state(connection: &ConnectionPhase, tokens: &TokenSet) -> Div {
	let (mark, label): (AnyElement, Option<String>) = match connection {
		ConnectionPhase::Attached => (Dot::role(ColorRole::DoneInk).into_any_element(), None),
		ConnectionPhase::Connecting { .. } => (waiting(), Some("Connecting".into())),
		ConnectionPhase::Syncing { .. } => (waiting(), Some("Syncing".into())),
		ConnectionPhase::Reconnecting { attempt, .. } => {
			(waiting(), Some(format!("Reconnecting, attempt {attempt}")))
		},
		ConnectionPhase::Fatal { .. } => {
			(Dot::role(ColorRole::ErrorInk).into_any_element(), Some("Host unreachable".into()))
		},
		ConnectionPhase::Detached => {
			(Dot::role(ColorRole::Muted).into_any_element(), Some("Offline".into()))
		},
		ConnectionPhase::NeedsSecret { .. } | ConnectionPhase::AwaitingExternalUrl { .. } => {
			(Dot::role(ColorRole::AttentionInk).into_any_element(), Some("Signing in".into()))
		},
	};

	div()
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.px(tokens.spacing(SpacingStep::S2))
		.child(mark)
		.children(label.map(|label| {
			div()
				.whitespace_nowrap()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Secondary))
				.child(label)
		}))
}

/// The mark for a phase that is waiting on the host.
fn waiting() -> AnyElement {
	Spinner::new().size(SpinnerSize::Small).into_any_element()
}

/// What the attention strip takes off the top of the window.
#[must_use]
pub fn attention_strip_height(tokens: &TokenSet) -> f32 {
	2.0f32.mul_add(
		f32::from(tokens.spacing(SpacingStep::S2)),
		f32::from(tokens.line_height(TextRamp::Micro)),
	)
}

/// Sanitizes notice text by shortening home directory paths and redacting
/// sensitive credentials.
fn sanitize_notice(text: &str) -> String {
	let mut sanitized = text.to_string();
	if let Some(idx) = sanitized.find("sk-") {
		let end = sanitized[idx..]
			.find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',' || c == ')')
			.map_or(sanitized.len(), |e| idx + e);
		if end - idx > 6 {
			sanitized.replace_range(idx..end, "sk-***");
		}
	}
	if let Some(idx) = sanitized.find("/home/")
		&& let Some(slash_after_user) = sanitized[idx + 6..].find('/')
	{
		sanitized.replace_range(idx..idx + 6 + slash_after_user, "~");
	} else if let Some(idx) = sanitized.find("/Users/")
		&& let Some(slash_after_user) = sanitized[idx + 7..].find('/')
	{
		sanitized.replace_range(idx..idx + 7 + slash_after_user, "~");
	}
	sanitized
}

/// The attention strip: one line, above everything, stating what happened and
/// the corrective action.
pub fn attention_strip(notice: &str, tokens: &TokenSet) -> Div {
	let sanitized = sanitize_notice(notice);
	let (primary_action, secondary_action) = if notice.contains("Authentication")
		|| notice.contains("API key")
		|| notice.contains("credentials")
	{
		(Some("Accounts"), "Dismiss")
	} else if notice.contains("Provider")
		|| notice.contains("rate limit")
		|| notice.contains("capacity")
	{
		(Some("Select Model"), "Dismiss")
	} else if notice.contains("Connection")
		|| notice.contains("socket")
		|| notice.contains("reconnect")
	{
		(Some("Retry"), "Dismiss")
	} else if notice.contains("Setting") || notice.contains("theme") || notice.contains("config") {
		(Some("Settings"), "Dismiss")
	} else if notice.contains("failed") || notice.contains("error") {
		(Some("Retry"), "Dismiss")
	} else {
		(None, "Dismiss")
	};

	let mut action_row = div()
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.flex_shrink_0();

	if let Some(action) = primary_action {
		action_row = action_row.child(
			div()
				.id(ElementId::Name(
					format!("attention-action-{}", action.to_lowercase().replace(' ', "-")).into(),
				))
				.px(tokens.spacing(SpacingStep::S2))
				.py(tokens.spacing(SpacingStep::S0))
				.rounded(tokens.radius(RadiusStep::Xs))
				.bg(tokens.color(ColorRole::AttentionInk))
				.text_color(tokens.color(ColorRole::AttentionFill))
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.cursor(CursorStyle::PointingHand)
				.child(action),
		);
	}

	action_row = action_row.child(
		div()
			.id(ElementId::Name("attention-dismiss".into()))
			.px(tokens.spacing(SpacingStep::S2))
			.py(tokens.spacing(SpacingStep::S0))
			.rounded(tokens.radius(RadiusStep::Xs))
			.border(tokens.stroke(StrokeStep::Hairline))
			.border_color(tokens.color(ColorRole::AttentionInk))
			.text_color(tokens.color(ColorRole::AttentionInk))
			.text_size(tokens.font_size(TextRamp::Micro))
			.line_height(tokens.line_height(TextRamp::Micro))
			.font_weight(tokens.font_weight(TextWeight::Medium))
			.cursor(CursorStyle::PointingHand)
			.child(secondary_action),
	);

	let left_content = div()
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.min_w_0()
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::AttentionInk))
				.child("⚠"),
		)
		.child(div().min_w_0().truncate().child(sanitized));

	div()
		.h(px(attention_strip_height(tokens)))
		.overflow_hidden()
		.w_full()
		.flex()
		.flex_row()
		.items_center()
		.justify_between()
		.px(tokens.spacing(SpacingStep::S4))
		.bg(tokens.color(ColorRole::AttentionFill))
		.border_b(tokens.stroke(StrokeStep::Hairline))
		.border_color(tokens.color(ColorRole::Hairline))
		.text_size(tokens.font_size(TextRamp::Micro))
		.line_height(tokens.line_height(TextRamp::Micro))
		.font_weight(tokens.font_weight(TextWeight::Medium))
		.text_color(tokens.color(ColorRole::AttentionInk))
		.child(left_content)
		.child(action_row)
}
