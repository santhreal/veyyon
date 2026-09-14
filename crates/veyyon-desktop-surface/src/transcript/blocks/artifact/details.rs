//! Expanded artifact details rendering for images and file mentions (§5.3).
//!
//! The frame carries the artefact, then the facts its row could not state, then
//! the actions on it. Which facts those are is decided in `facts`, so a frame
//! never restates the row that opened it.

use std::time::Instant;

use veyyon_desktop_kit::{
	ColorRole, Icon, IconName, IconSize, RadiusStep, SpacingStep, StrokeStep, TextRamp, TokenSet,
	controls::button::{Button, ButtonSize},
	state::InteractiveState,
};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{Div, ElementId, ParentElement, Styled, WeakEntity, div, img, px};

use super::{
	artifact_facts, artifact_image_status,
	decoder::ImageStatus,
	facts::{ArtifactFact, FactRole},
};
use crate::{Intent, ShellView, model::Artifact, transcript::state::TranscriptViewportState};

/// One fact line: an ordinary measurement, or a fault with its warning glyph.
fn render_fact(fact: ArtifactFact, tokens: &TokenSet) -> Div {
	match fact.role {
		FactRole::Note => div()
			.text_size(tokens.font_size(TextRamp::Micro))
			.text_color(tokens.color(ColorRole::Secondary))
			.child(fact.text),
		FactRole::Fault => div()
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
					.text_color(tokens.color(ColorRole::ErrorInk))
					.child(fact.text),
			),
	}
}

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

	let image_status = artifact_image_status(artifact);
	if let Some(ImageStatus::Valid { gpui_image, .. }) = &image_status {
		details = details.child(
			div()
				.flex()
				.w_full()
				.justify_center()
				.overflow_hidden()
				.child(
					img(gpui_image.clone())
						.max_w_full()
						.max_h(px(geometry.chrome_image_max_height_px))
						.rounded(tokens.radius(RadiusStep::Md)),
				),
		);
	}

	for fact in artifact_facts(artifact, image_status.as_ref()) {
		details = details.child(render_fact(fact, tokens));
	}

	// An image attachment has no path to open, so its frame carries one action.
	let mut actions = div().flex().flex_row().items_center().w_full();
	if let Artifact::File { path, unavailable_reason, .. } = artifact {
		let view_open = view.cloned();
		let path_open = path.clone();
		let mut open_button = Button::new(
			ElementId::Name(format!("artifact-open-{turn_ix}-{block_ix}").into()),
			"Open File",
		)
		.size(ButtonSize::Small)
		.leading_icon(IconName::File);
		if unavailable_reason.is_some() {
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
		actions = actions.justify_between().child(open_button);
	} else {
		actions = actions.justify_end();
	}

	details.child(
		actions.child(
			Button::new(
				ElementId::Name(format!("artifact-collapse-{turn_ix}-{block_ix}").into()),
				"Collapse",
			)
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
				if let Some(v) = &view_collapse {
					let _ = v.update(cx, |_view, cx| cx.notify());
				}
			}),
		),
	)
}
