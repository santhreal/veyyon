//! Transcript artifact presentation block (§5.3).
//!
//! Renders recorded image and file artifacts with interactive 24px collapsed
//! headers, expanded image viewing, format/dimension verification, explicit
//! corrupt-image diagnostics, and admission-gated file action dispatch.

mod decoder;
mod details;

use std::time::Instant;

pub use decoder::*;
pub use details::*;
use veyyon_desktop_kit::{
	ColorRole, Icon, IconName, IconSize, MonoSizeStep, SpacingStep, TextRamp, TokenSet, Truncate,
};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{
	CursorStyle, Div, InteractiveElement, ParentElement, Styled, WeakEntity, div, px,
};

use super::reveal::render_reveal_container;
use crate::{
	ShellView, composer::human_bytes, model::Artifact, transcript::state::TranscriptViewportState,
};

/// Formats line counts for display (e.g. "1 line", "42 lines").
pub fn format_lines(lines: u32) -> String {
	if lines == 1 {
		"1 line".to_string()
	} else {
		format!("{lines} lines")
	}
}

/// Summary text for file metadata in collapsed headers and detail overviews.
fn file_metadata_summary(
	has_content: bool,
	lines: Option<u32>,
	bytes: Option<u64>,
	unavailable_reason: Option<&str>,
	image_status: Option<&ImageStatus>,
) -> Option<String> {
	if let Some(reason) = unavailable_reason {
		return Some(reason.to_owned());
	}
	if let Some(ImageStatus::Valid { width, height, .. }) = image_status {
		return Some(format!("{width}×{height}"));
	}
	if let Some(ImageStatus::Error { .. }) = image_status {
		return Some("unsupported image".to_owned());
	}
	match (lines, bytes) {
		(Some(l), Some(b)) => Some(format!("{} · {}", format_lines(l), human_bytes(b))),
		(Some(l), None) => Some(format_lines(l)),
		(None, Some(b)) => Some(human_bytes(b)),
		(None, None) => {
			if has_content {
				Some("content available".to_owned())
			} else {
				None
			}
		},
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

	let (leading_icon, title, summary, has_error) = match artifact {
		Artifact::Image { media_type, data, alt } => {
			let status = get_or_decode_image(data, Some(media_type));
			let err = matches!(status, ImageStatus::Error { .. });
			let summary_str = match &status {
				ImageStatus::Valid { width, height, .. } => Some(format!("{width}×{height}")),
				ImageStatus::Error { .. } => Some("decode error".to_string()),
			};
			let title_str = alt
				.as_deref()
				.filter(|s| !s.is_empty())
				.unwrap_or("Image attachment");
			(IconName::Image, title_str.to_owned(), summary_str, err)
		},
		Artifact::File { path, has_content, lines, bytes, unavailable_reason, image } => {
			let image_status = image
				.as_ref()
				.map(|img_bytes| get_or_decode_image(img_bytes, None));
			let icon = if image.is_some() {
				IconName::Image
			} else {
				IconName::File
			};
			let err =
				unavailable_reason.is_some() || matches!(image_status, Some(ImageStatus::Error { .. }));
			let summary_str = file_metadata_summary(
				*has_content,
				*lines,
				*bytes,
				unavailable_reason.as_deref(),
				image_status.as_ref(),
			);
			(icon, path.clone(), summary_str, err)
		},
	};

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
