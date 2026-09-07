//! Expanded artifact details rendering for images and file mentions (§5.3).

use std::time::Instant;

use veyyon_desktop_kit::{
	ColorRole, Icon, IconName, IconSize, MonoSizeStep, RadiusStep, SpacingStep, StrokeStep,
	TextRamp, TextWeight, TokenSet,
	controls::button::{Button, ButtonSize},
	state::InteractiveState,
};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{Div, ParentElement, Styled, WeakEntity, div, img, px};

use super::decoder::{ImageStatus, get_or_decode_image};
use crate::{
	Intent, ShellView, composer::human_bytes, model::Artifact,
	transcript::state::TranscriptViewportState,
};

/// Renders the expanded details container for image attachments or file
/// mentions.
pub fn render_artifact_details(
	turn_ix: usize,
	block_ix: usize,
	artifact: &Artifact,
	geometry: &TranscriptSurfaceTokens,
	tokens: &TokenSet,
	motion_tokens: &MotionTokens,
	reduced_motion: bool,
	viewport_state: &TranscriptViewportState,
	view: Option<&WeakEntity<ShellView>>,
	has_error: bool,
) -> Div {
	let state_collapse = viewport_state.clone();
	let motion_tokens_collapse = motion_tokens.clone();
	let view_collapse = view.cloned();

	let mut details = div()
		.flex()
		.flex_col()
		.w_full()
		.mt(tokens.spacing(SpacingStep::S2))
		.p(tokens.spacing(SpacingStep::S3))
		.bg(tokens.color(ColorRole::Canvas))
		.rounded(tokens.radius(RadiusStep::Md))
		.border(tokens.stroke(StrokeStep::Hairline))
		.border_color(if has_error {
			tokens.color(ColorRole::ErrorFill)
		} else {
			tokens.color(ColorRole::Hairline)
		})
		.gap(tokens.spacing(SpacingStep::S2));

	match artifact {
		Artifact::Image { media_type, data, alt } => {
			let image_status = get_or_decode_image(data, Some(media_type));
			match image_status {
				ImageStatus::Valid { width, height, format, gpui_image } => {
					if let Some(alt_text) = alt
						&& !alt_text.is_empty()
					{
						details = details.child(
							div()
								.text_size(tokens.font_size(TextRamp::Micro))
								.text_color(tokens.color(ColorRole::Muted))
								.child(alt_text.clone()),
						);
					}
					details = details.child(
						div()
							.flex()
							.w_full()
							.justify_center()
							.overflow_hidden()
							.child(
								img(gpui_image)
									.max_w_full()
									.max_h(px(geometry.chrome_image_max_height_px))
									.rounded(tokens.radius(RadiusStep::Md)),
							),
					);
					details = details.child(
						div()
							.flex()
							.flex_row()
							.justify_between()
							.items_center()
							.w_full()
							.child(
								div()
									.text_size(tokens.font_size(TextRamp::Micro))
									.text_color(tokens.color(ColorRole::Secondary))
									.child(format!(
										"{} · {} × {} px · {}",
										format.mime_type(),
										width,
										height,
										human_bytes(data.len() as u64)
									)),
							)
							.child(Button::new("Collapse").size(ButtonSize::Small).on_click(
								move |_event, _window, cx| {
									state_collapse.set_block_expanded(
										turn_ix,
										block_ix,
										false,
										&motion_tokens_collapse,
										reduced_motion,
										Instant::now(),
									);
									if let Some(v) = &view_collapse {
										let _ = v.update(cx, |_view, cx| cx.notify());
									}
								},
							)),
					);
				},
				ImageStatus::Error { message } => {
					details = details.child(
						div()
							.flex()
							.flex_row()
							.items_center()
							.gap(tokens.spacing(SpacingStep::S2))
							.child(
								Icon::new(IconName::Warning)
									.size(IconSize::Size14)
									.color(tokens.color(ColorRole::ErrorInk)),
							)
							.child(
								div()
									.text_size(tokens.font_size(TextRamp::Small))
									.font_weight(tokens.font_weight(TextWeight::Medium))
									.text_color(tokens.color(ColorRole::ErrorInk))
									.child("Image decode error"),
							),
					);
					details = details.child(
						div()
							.text_size(tokens.font_size(TextRamp::Micro))
							.text_color(tokens.color(ColorRole::Secondary))
							.child(message),
					);
					if let Some(alt_text) = alt
						&& !alt_text.is_empty()
					{
						details = details.child(
							div()
								.text_size(tokens.font_size(TextRamp::Micro))
								.text_color(tokens.color(ColorRole::Muted))
								.child(format!("Alt text: {alt_text}")),
						);
					}
					details = details.child(div().flex().justify_end().w_full().child(
						Button::new("Collapse").size(ButtonSize::Small).on_click(
							move |_event, _window, cx| {
								state_collapse.set_block_expanded(
									turn_ix,
									block_ix,
									false,
									&motion_tokens_collapse,
									reduced_motion,
									Instant::now(),
								);
								if let Some(v) = &view_collapse {
									let _ = v.update(cx, |_view, cx| cx.notify());
								}
							},
						),
					));
				},
			}
		},
		Artifact::File { path, has_content, lines, bytes, unavailable_reason, image } => {
			let view_open = view.cloned();
			let path_open = path.clone();
			let is_unavailable = unavailable_reason.is_some();
			let mut open_button = Button::new("Open File")
				.size(ButtonSize::Small)
				.leading_icon(IconName::File);

			if is_unavailable {
				open_button = open_button.state(InteractiveState::Disabled);
			} else {
				open_button = open_button.on_click(move |_event, _window, cx| {
					if let Some(v) = &view_open {
						let p = path_open.clone();
						let _ = v.update(cx, |view, cx| {
							view.dispatch(Intent::OpenFile(p), cx);
						});
					}
				});
			}

			if let Some(img_data) = image {
				let image_status = get_or_decode_image(img_data, None);
				match image_status {
					ImageStatus::Valid { width, height, format, gpui_image } => {
						details = details.child(
							div()
								.text_size(tokens.mono_font_size(MonoSizeStep::Small))
								.font_weight(tokens.font_weight(TextWeight::Medium))
								.text_color(tokens.color(ColorRole::Foreground))
								.child(format!("File: {path}")),
						);
						details = details.child(
							div()
								.flex()
								.w_full()
								.justify_center()
								.overflow_hidden()
								.child(
									img(gpui_image)
										.max_w_full()
										.max_h(px(geometry.chrome_image_max_height_px))
										.rounded(tokens.radius(RadiusStep::Md)),
								),
						);
						details = details.child(
							div()
								.text_size(tokens.font_size(TextRamp::Micro))
								.text_color(tokens.color(ColorRole::Secondary))
								.child(format!(
									"{} · {} × {} px · {}",
									format.mime_type(),
									width,
									height,
									human_bytes(img_data.len() as u64)
								)),
						);
					},
					ImageStatus::Error { message } => {
						details = details.child(
							div()
								.flex()
								.flex_row()
								.items_center()
								.gap(tokens.spacing(SpacingStep::S2))
								.child(
									Icon::new(IconName::Warning)
										.size(IconSize::Size14)
										.color(tokens.color(ColorRole::ErrorInk)),
								)
								.child(
									div()
										.text_size(tokens.font_size(TextRamp::Small))
										.font_weight(tokens.font_weight(TextWeight::Medium))
										.text_color(tokens.color(ColorRole::ErrorInk))
										.child("Embedded image decode error"),
								),
						);
						details = details.child(
							div()
								.text_size(tokens.font_size(TextRamp::Micro))
								.text_color(tokens.color(ColorRole::Secondary))
								.child(message),
						);
					},
				}
			} else {
				details = details.child(
					div()
						.text_size(tokens.mono_font_size(MonoSizeStep::Small))
						.font_weight(tokens.font_weight(TextWeight::Medium))
						.text_color(tokens.color(ColorRole::Foreground))
						.child(format!("Path: {path}")),
				);
				if let Some(reason) = unavailable_reason {
					details = details.child(
						div()
							.text_size(tokens.font_size(TextRamp::Small))
							.text_color(tokens.color(ColorRole::ErrorInk))
							.child(format!("Unavailable: {reason}")),
					);
				}
				if let Some(l) = lines {
					details = details.child(
						div()
							.text_size(tokens.font_size(TextRamp::Micro))
							.text_color(tokens.color(ColorRole::Secondary))
							.child(format!("Recorded lines: {l}")),
					);
				}
				if let Some(b) = bytes {
					details = details.child(
						div()
							.text_size(tokens.font_size(TextRamp::Micro))
							.text_color(tokens.color(ColorRole::Secondary))
							.child(format!("Recorded size: {}", human_bytes(*b))),
					);
				}
				if *has_content {
					details = details.child(
						div()
							.text_size(tokens.font_size(TextRamp::Micro))
							.text_color(tokens.color(ColorRole::Secondary))
							.child("Content is available in workspace. Use Open File to inspect."),
					);
				}
			}

			details = details.child(
				div()
					.flex()
					.flex_row()
					.justify_between()
					.items_center()
					.w_full()
					.child(open_button)
					.child(Button::new("Collapse").size(ButtonSize::Small).on_click(
						move |_event, _window, cx| {
							state_collapse.set_block_expanded(
								turn_ix,
								block_ix,
								false,
								&motion_tokens_collapse,
								reduced_motion,
								Instant::now(),
							);
							if let Some(v) = &view_collapse {
								let _ = v.update(cx, |_view, cx| cx.notify());
							}
						},
					)),
			);
		},
	}

	details
}
