//! Read-only history preview through the regular transcript renderer.

use veyyon_desktop_kit::{
	Button, ButtonSize, ButtonVariant, ColorRole, SpacingStep, TextRamp, TokenSet,
};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{
	Context, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement, Styled,
	div, px,
};

use crate::{Intent, ShellView, Turn, damage::LaidOut, transcript::transcript_column};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryState {
	pub session:  String,
	pub turns:    Vec<Turn>,
	pub loading:  bool,
	pub error:    Option<String>,
	pub revision: Option<u64>,
}

impl HistoryState {
	#[must_use]
	pub const fn loading(session: String) -> Self {
		Self { session, turns: Vec::new(), loading: true, error: None, revision: None }
	}
}

/// No composer, branch action, tool mutation callback or live viewport state is
/// present.
pub fn history_surface(
	state: &HistoryState,
	geometry: &TranscriptSurfaceTokens,
	user_ground: ColorRole,
	tokens: &TokenSet,
	motion: &MotionTokens,
	laid_out: &LaidOut,
	measure_px: f32,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let target = state.session.clone();
	let retry = state.session.clone();
	let mut header = div()
		.flex()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(
			div()
				.flex_1()
				.text_size(tokens.font_size(TextRamp::Head))
				.child("History · Read only"),
		)
		.child(
			Button::new("history-back", "Sessions")
				.size(ButtonSize::Small)
				.variant(ButtonVariant::Ghost)
				.on_click(
					cx.listener(|view, _, _, cx| view.dispatch(Intent::FindSessions(String::new()), cx)),
				),
		)
		.child(
			Button::new("history-close", "Close")
				.size(ButtonSize::Small)
				.variant(ButtonVariant::Ghost)
				.on_click(cx.listener(|view, _, _, cx| view.dispatch(Intent::CloseOverlay, cx))),
		);
	if !state.loading && state.error.is_none() {
		header = header.child(
			Button::new("history-resume", "Resume session")
				.size(ButtonSize::Small)
				.on_click(cx.listener(move |view, _, _, cx| {
					view.dispatch(Intent::ResumeHistory(target.clone()), cx);
				})),
		);
	}
	let mut body = div()
		.id("history-transcript")
		.flex_1()
		.min_h(px(0.0))
		.overflow_y_scroll();
	if let Some(error) = &state.error {
		body = body.child(div().child(error.clone())).child(
			Button::new("history-retry", "Retry loading")
				.size(ButtonSize::Small)
				.on_click(cx.listener(move |view, _, _, cx| {
					view.dispatch(Intent::PreviewSession(retry.clone()), cx);
				})),
		);
	} else if state.loading {
		body = body.child("Loading transcript…");
	} else if state.turns.is_empty() {
		body = body.child("This session has no messages");
	} else {
		body = body.child(transcript_column(
			&state.turns,
			geometry,
			user_ground,
			tokens,
			motion,
			laid_out,
			measure_px,
		));
	}
	div()
		.flex()
		.flex_col()
		.w_full()
		.h_full()
		.min_h(px(0.0))
		.p(tokens.spacing(SpacingStep::S3))
		.gap(tokens.spacing(SpacingStep::S3))
		.text_color(tokens.color(ColorRole::Foreground))
		.child(header)
		.child(body)
}
