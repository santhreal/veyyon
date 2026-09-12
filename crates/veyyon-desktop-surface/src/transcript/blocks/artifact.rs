//! Transcript artifact presentation block (§5.3).
//!
//! Renders recorded image and file artifacts with interactive 24px collapsed
//! headers, expanded image viewing, format/dimension verification, explicit
//! corrupt-image diagnostics, and admission-gated file action dispatch. What
//! the row states and what its frame states are decided in `facts`.

mod decoder;
mod details;
mod facts;

use std::time::Instant;

pub use decoder::*;
pub use details::*;
pub use facts::*;
use veyyon_desktop_kit::{
	ColorRole, Icon, IconName, IconSize, MonoSizeStep, SpacingStep, TextRamp, TokenSet, Truncate,
};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{
	CursorStyle, Div, InteractiveElement, ParentElement, Styled, WeakEntity, div, px,
};

use super::reveal::render_reveal_container;
use crate::{ShellView, model::Artifact, transcript::state::TranscriptViewportState};

/// The decode result for whatever image an artefact carries, if any. Decoding
/// is cached per payload, so the row and its frame read the same result.
pub fn artifact_image_status(artifact: &Artifact) -> Option<ImageStatus> {
	match artifact {
		Artifact::Image { media_type, data, .. } => Some(get_or_decode_image(data, Some(media_type))),
		Artifact::File { image, .. } => image
			.as_ref()
			.map(|img_bytes| get_or_decode_image(img_bytes, None)),
	}
}

/// Artifact block: renders image attachments and file mentions collapsed to a
/// 24px interactive line, expanding to full images or file actions.
pub fn render_artifact_block(
	turn_ix: usize,
	block_ix: usize,
	artifact: &Artifact,
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
	let motion_tokens_toggle = motion_tokens.clone();
	let view_toggle = view.cloned();

	let ArtifactRow { icon: leading_icon, title, summary, fault: has_error } =
		artifact_row(artifact, artifact_image_status(artifact).as_ref());

	let mut header = div()
		.h(px(geometry.chrome_collapsed_height_px))
		.w_full()
		.flex()
		.flex_row()
		.items_center()
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
			if let Some(v) = &view_toggle {
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
			div().flex_shrink_0().child(
				Icon::new(leading_icon)
					.size(IconSize::Size12)
					.color(tokens.color(ColorRole::Secondary)),
			),
		)
		.child(
			div().flex_1().min_w_0().child(
				Truncate::new(title)
					.mono(MonoSizeStep::Small)
					.color(ColorRole::Foreground),
			),
		);

	if let Some(summary_text) = summary {
		let color = if has_error {
			ColorRole::ErrorInk
		} else {
			ColorRole::Muted
		};
		header = header.child(
			div()
				.flex_shrink_0()
				.max_w(px(geometry.chrome_invoke_mono_pane_max_height_px))
				.min_w_0()
				.child(
					Truncate::new(summary_text)
						.ramp(TextRamp::Micro)
						.color(color),
				),
		);
	}

	let mut container = div().flex().flex_col().w_full().child(header);

	let (progress, _) = viewport_state.reveal_frame(turn_ix, block_ix, Instant::now());
	let is_revealing = is_expanded || progress > 0.0;

	if is_revealing {
		let details = render_artifact_details(
			turn_ix,
			block_ix,
			artifact,
			geometry,
			tokens,
			motion_tokens,
			reduced_motion,
			viewport_state,
			view,
			has_error,
		);

		if let Some(revealed) =
			render_reveal_container(turn_ix, block_ix, is_expanded, viewport_state, view, details)
		{
			container = container.child(revealed);
		}
	}

	container
}
