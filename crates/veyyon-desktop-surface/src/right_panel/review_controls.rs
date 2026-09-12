//! Review entry points shared by the file headers and change listing.

use std::collections::BTreeMap;

use veyyon_desktop_kit::{ColorRole, SpacingStep, TextRamp, TokenSet};
use veyyon_desktop_model::review::ReviewsStore;
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	Context, ElementId, InteractiveElement, IntoElement, MouseButton, MouseDownEvent, ParentElement,
	Styled, div, px,
};

use super::{
	PanelContent,
	review::{in_repository, unresolved},
};
use crate::ShellView;

#[derive(Default)]
pub struct ReviewCounts {
	pub enabled: bool,
	pub total:   usize,
	pub files:   BTreeMap<String, usize>,
}

impl ReviewCounts {
	pub fn of(panel: &PanelContent, reviews: &ReviewsStore) -> Self {
		let mut counts = Self { enabled: panel.review_repository.is_some(), ..Self::default() };
		for thread in &reviews.threads {
			if in_repository(panel, thread) && unresolved(thread) {
				counts.total += 1;
				*counts.files.entry(thread.anchor.file.clone()).or_default() += 1;
			}
		}
		counts
	}
}

pub fn review_button(
	path: Option<String>,
	count: usize,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let id = format!("review-threads-{}", path.as_deref().unwrap_or("all"));
	div()
		.id(ElementId::Name(id.into()))
		.flex_shrink_0()
		.cursor_pointer()
		.on_mouse_down(
			MouseButton::Left,
			cx.listener(move |view, event: &MouseDownEvent, window, cx| {
				view.open_review_threads(path.clone(), event.position, window, cx);
				cx.stop_propagation();
			}),
		)
		.px(tokens.spacing(SpacingStep::S2))
		.hover(|style| style.bg(tokens.row_hover()))
		.text_size(tokens.font_size(TextRamp::Micro))
		.text_color(tokens.color(ColorRole::Secondary))
		.child(format!("Reviews · {count} unresolved"))
}

pub fn review_bar(
	counts: &ReviewCounts,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	div()
		.h(px(geometry.chrome_row_height_px))
		.w_full()
		.min_w_0()
		.flex_shrink_0()
		.flex()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(review_button(None, counts.total, tokens, cx))
		.child(
			div()
				.min_w_0()
				.truncate()
				.text_size(tokens.font_size(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child("Click a line number to comment"),
		)
}
