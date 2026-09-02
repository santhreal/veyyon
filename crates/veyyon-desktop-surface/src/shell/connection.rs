//! Connection status banner and per-control error hairline presentation (§4.3,
//! §4.4, §8.12).
//!
//! Renders the top-level reconnection banner beneath the titlebar during
//! transport disruptions, as well as the inline error hairline attached to
//! controls that experienced request failures.

use veyyon_desktop_kit::{
	Button, ButtonSize, ButtonVariant, ColorRole, SpacingStep, StrokeStep, TextRamp, TokenSet,
};
use veyyon_gpui::{ClickEvent, InteractiveElement, IntoElement, ParentElement, Styled, div};

pub use crate::controls::{ControlError, error_hairline};
use crate::{ConnectionPhase, Intent, ShellView};

/// Renders the top-level connection status banner if the active phase requires
/// operator attention (§8.12).
pub fn connection_banner(
	phase: &ConnectionPhase,
	now_ms: u64,
	tokens: &TokenSet,
	cx: &veyyon_gpui::Context<ShellView>,
) -> Option<impl IntoElement> {
	match phase {
		ConnectionPhase::Reconnecting { attempt, message, retry_at_ms } => {
			let stroke_px = tokens.stroke(StrokeStep::Hairline);
			let hairline_color = tokens.color(ColorRole::Hairline);
			let ground_color = tokens.color(ColorRole::Canvas);
			let fg_color = tokens.color(ColorRole::Foreground);
			let sec_color = tokens.color(ColorRole::Secondary);
			let pad_h = tokens.spacing(SpacingStep::S4);
			let pad_v = tokens.spacing(SpacingStep::S2);
			let font_size = tokens.font_size(TextRamp::Micro);
			let line_height = tokens.line_height(TextRamp::Micro);

			let countdown = if *retry_at_ms > now_ms {
				let remaining_ms = retry_at_ms - now_ms;
				let remaining_secs = remaining_ms.div_ceil(1000);
				if remaining_secs > 0 {
					format!("retrying in {remaining_secs}s")
				} else {
					"retrying now".to_string()
				}
			} else {
				"retrying now".to_string()
			};

			let countdown_text = format!("Reconnecting (attempt {attempt}) · {countdown} ");
			let message_text = format!("— {message}");

			let label = div()
				.flex()
				.flex_row()
				.items_center()
				.text_size(font_size)
				.line_height(line_height)
				.child(div().text_color(fg_color).child(countdown_text))
				.child(div().text_color(sec_color).child(message_text));

			let retry_btn = Button::new("Retry Now")
				.id("banner-retry-btn")
				.variant(ButtonVariant::Ghost)
				.size(ButtonSize::Small)
				.on_click(cx.listener(|view, _event: &ClickEvent, _window, _cx| {
					view.dispatch(Intent::RetryConnection);
				}));

			let banner = div()
				.id("reconnecting-banner")
				.w_full()
				.flex()
				.flex_row()
				.items_center()
				.justify_between()
				.px(pad_h)
				.py(pad_v)
				.bg(ground_color)
				.border_b(stroke_px)
				.border_color(hairline_color)
				.child(label)
				.child(retry_btn);

			Some(banner)
		},
		ConnectionPhase::Fatal { message } => {
			let stroke_px = tokens.stroke(StrokeStep::Hairline);
			let error_color = tokens.color(ColorRole::ErrorInk);
			let ground_color = tokens.color(ColorRole::Canvas);
			let text_color = tokens.color(ColorRole::ErrorInk);
			let pad_h = tokens.spacing(SpacingStep::S4);
			let pad_v = tokens.spacing(SpacingStep::S2);
			let font_size = tokens.font_size(TextRamp::Micro);
			let line_height = tokens.line_height(TextRamp::Micro);

			let label = div()
				.text_size(font_size)
				.line_height(line_height)
				.text_color(text_color)
				.child(format!("Fatal connection error: {message}"));

			let retry_btn = Button::new("Re-attach")
				.id("banner-reattach-btn")
				.variant(ButtonVariant::Danger)
				.size(ButtonSize::Small)
				.on_click(cx.listener(|view, _event: &ClickEvent, _window, _cx| {
					view.dispatch(Intent::RetryConnection);
				}));

			let banner = div()
				.id("fatal-banner")
				.w_full()
				.flex()
				.flex_row()
				.items_center()
				.justify_between()
				.px(pad_h)
				.py(pad_v)
				.bg(ground_color)
				.border_b(stroke_px)
				.border_color(error_color)
				.child(label)
				.child(retry_btn);

			Some(banner)
		},
		_ => None,
	}
}
