//! Window titlebar chrome and the attention strip (§4.1).
//!
//! The titlebar carries four things: the queue rail control, the open
//! session's name, the connection state, and the right panel and drawer
//! controls. Window controls are the platform's: macOS draws its traffic
//! lights into the inset this bar leaves for them, and elsewhere the window
//! manager's own decorations sit above the bar.

use veyyon_desktop_kit::{
	ColorRole, Dot, IconButton, IconButtonVariant, IconName, IconSize, SpacingStep, Spinner,
	SpinnerSize, StrokeStep, TextRamp, TextWeight, TokenSet,
};
use veyyon_desktop_tokens::ShellSurfaceTokens;
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, Div, InteractiveElement, IntoElement, MouseMoveEvent,
	ParentElement, StatefulInteractiveElement, Styled, div, px,
};

use crate::{Intent, ShellView, attach::ConnectionPhase};

/// The room macOS traffic lights take at the bar's left edge when the window
/// draws its own titlebar (§4.1). Other platforms draw their controls outside
/// the bar, so they take nothing from it.
#[must_use]
pub const fn platform_inset_left_px() -> f32 {
	if cfg!(target_os = "macos") { 78.0 } else { 0.0 }
}

/// What the titlebar shows, read from the shell's state.
#[derive(Debug, Clone, Copy)]
pub struct TitlebarState<'a> {
	pub title:           &'a str,
	pub connection:      &'a ConnectionPhase,
	pub queue_collapsed: bool,
	/// Whether there is a panel to show; the control is hidden without one.
	pub panel_available: bool,
	pub panel_collapsed: bool,
	pub drawer_open:     bool,
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
			cx,
			|view, cx| {
				view.dispatch(Intent::ToggleQueue, cx);
			},
		));

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
			cx,
			|view, cx| view.dispatch(Intent::TogglePanel, cx),
		));
	}
	trailing = trailing.child(toggle_control(
		"titlebar-drawer",
		IconName::Terminal,
		state.drawer_open,
		cx,
		|view, cx| {
			let open = !view.state().drawer_open;
			view.dispatch(Intent::SetDrawer { open }, cx);
		},
	));

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
		.child(
			div()
				.flex_1()
				.min_w_0()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.text_center()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Secondary))
				.child(state.title.to_owned()),
		)
		.child(trailing)
}

/// One 28px titlebar control: ink alone at rest, the selected wash while what
/// it controls is shown, the hover wash under the pointer.
fn toggle_control(
	id: &'static str,
	icon: IconName,
	shown: bool,
	cx: &Context<ShellView>,
	on_click: impl Fn(&mut ShellView, &mut Context<ShellView>) + 'static,
) -> impl IntoElement {
	let variant = if shown {
		IconButtonVariant::Subtle
	} else {
		IconButtonVariant::Ghost
	};
	IconButton::new(icon)
		.id(id)
		.size(IconSize::Size14)
		.variant(variant)
		.on_click(cx.listener(move |view, _event: &ClickEvent, _window, cx| {
			on_click(view, cx);
		}))
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

/// The attention strip: one line, above everything, that something is wrong.
pub fn attention_strip(notice: &str, tokens: &TokenSet) -> Div {
	div()
		.w_full()
		.flex()
		.flex_row()
		.items_center()
		.justify_center()
		.py(tokens.spacing(SpacingStep::S2))
		.px(tokens.spacing(SpacingStep::S4))
		.bg(tokens.color(ColorRole::AttentionFill))
		.border_b(tokens.stroke(StrokeStep::Hairline))
		.border_color(tokens.color(ColorRole::Hairline))
		.text_size(tokens.font_size(TextRamp::Micro))
		.line_height(tokens.line_height(TextRamp::Micro))
		.font_weight(tokens.font_weight(TextWeight::Medium))
		.text_color(tokens.color(ColorRole::AttentionInk))
		.child(notice.to_owned())
}
