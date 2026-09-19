//! Bounded attachment previews, metadata, removal and submission refusals.

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{
	ColorRole, Icon, IconButton, IconButtonVariant, IconName, IconSize, SpacingStep, StrokeStep,
	TextRamp, TokenSet, Tooltip,
};
use veyyon_desktop_tokens::ComposerSurfaceTokens;
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, Div, ElementId, FontWeight, InteractiveElement, IntoElement,
	ObjectFit, ParentElement, Stateful, StatefulInteractiveElement, Styled, StyledImage, div, img,
	px,
};

use super::{
	TurnPhase,
	media::{MediaKind, MediaType},
	preview::AttachmentPreview,
	state::{Attachment, ComposerState},
};
use crate::{Intent, ShellView};

/// The tray above the footer. Nothing when nothing is attached.
pub fn attachment_tray(
	composer: &ComposerState,
	turn: &TurnPhase,
	geometry: &ComposerSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Stateful<Div> {
	div()
		.id("composer-attachments")
		.w_full()
		.max_h(px(geometry.attachment_card_height_px * 2.0) + tokens.spacing(SpacingStep::S2))
		.overflow_y_scroll()
		.flex()
		.flex_row()
		.flex_wrap()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.children(
			composer
				.attachments
				.iter()
				.enumerate()
				.map(|(index, attachment)| {
					let refusal = composer.rejection_reason(attachment);
					attachment_card(index, attachment, refusal.as_deref(), geometry, tokens, cx)
				}),
		)
		.children(matches!(turn, TurnPhase::Running { .. }).then(|| {
			// A running turn takes text alone: a steer or a follow-up carries
			// no media, so what is attached waits for the next prompt.
			div()
				.pl(tokens.spacing(SpacingStep::S2))
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Placeholder))
				.whitespace_nowrap()
				.child("Sent with the next prompt")
		}))
}

/// One card: thumbnail, name, caption, and the remove control on hover.
fn attachment_card(
	index: usize,
	attachment: &Attachment,
	unsupported_by: Option<&str>,
	geometry: &ComposerSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	let edge = if unsupported_by.is_some() {
		tokens.color(ColorRole::Accent)
	} else {
		tokens.color(ColorRole::Hairline)
	};
	let mut hover_wash = tokens.color(ColorRole::Foreground);
	hover_wash.a = 0.04;

	let caption = match unsupported_by {
		Some(model) => caption_row(
			Some(IconName::Warning),
			format!("{} · {model}", size_caption(attachment)),
			ColorRole::Accent,
			tokens,
		),
		None => caption_row(None, size_caption(attachment), ColorRole::Secondary, tokens),
	};

	// The card is capped at its authored width, so a long name and a refusal
	// both ellipsise in it. The tooltip states them in full, and is the same
	// sentence the label reads out.
	let statement = format!(
		"{} · {}{}",
		attachment.name,
		size_caption(attachment),
		unsupported_by.map_or_else(String::new, |reason| format!(" · {reason}"))
	);
	let card = div()
		.id(ElementId::NamedInteger("composer-attachment".into(), index as u64))
		.group("composer-attachment")
		.aria_label(statement.clone())
		.relative()
		.h(px(geometry.attachment_card_height_px))
		.max_w(px(geometry.attachment_card_max_width_px))
		.rounded(px(geometry.attachment_card_radius))
		// The card is an inset object on the composer's float, so it takes the
		// inset ground: the hairline edge alone is the float's own colour at
		// this elevation and leaves the card's bounds unreadable.
		.bg(tokens.color(ColorRole::Inset))
		.border(tokens.stroke(StrokeStep::Hairline))
		.border_color(edge)
		.overflow_hidden()
		.flex()
		.flex_row()
		.items_center()
		.hover(move |style| style.bg(hover_wash))
		.child(thumbnail(attachment, geometry, tokens))
		.child(thumbnail_rule(tokens))
		.child(
			div()
				.min_w_0()
				.flex_1()
				.px(tokens.spacing(SpacingStep::S4))
				.flex()
				.flex_col()
				.gap(tokens.spacing(SpacingStep::S1))
				.child(
					div()
						.text_size(tokens.font_size(TextRamp::Body))
						.line_height(tokens.line_height(TextRamp::Body))
						.font_weight(FontWeight::MEDIUM)
						.text_color(tokens.color(ColorRole::Foreground))
						.whitespace_nowrap()
						.overflow_hidden()
						.text_ellipsis()
						.child(attachment.name.clone()),
				)
				.child(caption),
		)
		.child(
			// The remove control sits in the card's upper-right corner and is
			// drawn only while the card is hovered, so a tray of six reads as
			// six files rather than six closes.
			div()
				.absolute()
				.top(tokens.spacing(SpacingStep::S1))
				.right(tokens.spacing(SpacingStep::S1))
				.invisible()
				.group_hover("composer-attachment", |style| style.visible())
				.child(
					IconButton::new(
						ElementId::NamedInteger("composer-attachment-remove".into(), index as u64),
						IconName::Close,
					)
					.size(IconSize::Size12)
					.variant(IconButtonVariant::Ghost)
					.on_click(cx.listener(move |view, _event: &ClickEvent, _window, cx| {
						view.dispatch(Intent::RemoveAttachment(index), cx);
					})),
				),
		);
	Tooltip::new(statement, card).above().into_any_element()
}

/// The square at the card's leading edge: the image, or a film glyph.
///
/// The card carries the inset ground, so the square needs no ground of its
/// own. It is parted from the name beside it by [`thumbnail_rule`], which is
/// a line and not an edge: a one-sided border inside the composer's rounded
/// clip is the shape of the renderer defect
/// `a-bordered-box-inside-the-composer-draws-all-four-of-its-edges` reads for.
fn thumbnail(
	attachment: &Attachment,
	geometry: &ComposerSurfaceTokens,
	tokens: &TokenSet,
) -> AnyElement {
	let side = px(geometry.attachment_card_height_px);
	match &attachment.preview {
		AttachmentPreview::Image(image) => img(image.clone())
			.w(side)
			.h(side)
			.flex_none()
			.object_fit(ObjectFit::Cover)
			.into_any_element(),
		AttachmentPreview::Video => div()
			.w(side)
			.h(side)
			.flex_none()
			.flex()
			.items_center()
			.justify_center()
			.child(
				Icon::new(IconName::Film)
					.size(IconSize::Size20)
					.color(tokens.color(ColorRole::Secondary)),
			)
			.into_any_element(),
		AttachmentPreview::Text(text)
		| AttachmentPreview::Binary(text)
		| AttachmentPreview::Unavailable(text) => div()
			.w(side)
			.h(side)
			.flex_none()
			.overflow_hidden()
			.p(tokens.spacing(SpacingStep::S1))
			.text_size(tokens.font_size(TextRamp::Micro))
			.line_height(tokens.line_height(TextRamp::Micro))
			.text_color(tokens.color(ColorRole::Secondary))
			.child(text.clone())
			.into_any_element(),
	}
}

/// The line between the square and the name it belongs to.
fn thumbnail_rule(tokens: &TokenSet) -> Div {
	div()
		.w(tokens.stroke(StrokeStep::Hairline))
		.h_full()
		.flex_none()
		.bg(tokens.color(ColorRole::Hairline))
}

/// Why the last attachment was refused, in the accent, with its own close.
/// It sits where the cards do, so the refusal is read beside what was kept.
pub fn attachment_notice(
	notice: &str,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Stateful<Div> {
	div()
		.id("composer-attachment-notice")
		.w_full()
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(
			Icon::new(IconName::Warning)
				.size(IconSize::Size12)
				.color(tokens.color(ColorRole::Accent)),
		)
		.child(
			div()
				.min_w_0()
				.flex_1()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Accent))
				.whitespace_nowrap()
				.overflow_hidden()
				.text_ellipsis()
				.child(notice.to_owned()),
		)
		.child(
			IconButton::new("composer-attachment-notice-close", IconName::Close)
				.size(IconSize::Size12)
				.variant(IconButtonVariant::Ghost)
				.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
					view.clear_composer_notice();
					cx.notify();
				})),
		)
}

/// The classified type and exact encoded byte count, including on refused
/// cards.
fn size_caption(attachment: &Attachment) -> String {
	format!("{} · {} B", attachment.media.spelling(), attachment.bytes())
}

/// The card's second line, optionally led by a 12px glyph in the same ink.
///
/// The text is a box of its own rather than a child of the row, which is what
/// bounds it: a nowrap string sitting directly in a flex row reports its whole
/// measure as that row's minimum, so a refusal naming a long model drew past
/// the card's ceiling while the card stayed at it. Cut inside its own box, the
/// line ends in an ellipsis at whatever the glyph leaves it.
fn caption_row(glyph: Option<IconName>, text: String, ink: ColorRole, tokens: &TokenSet) -> Div {
	div()
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.text_size(tokens.font_size(TextRamp::Micro))
		.line_height(tokens.line_height(TextRamp::Micro))
		.text_color(tokens.color(ink))
		.overflow_hidden()
		.children(glyph.map(|name| {
			Icon::new(name)
				.size(IconSize::Size12)
				.color(tokens.color(ink))
		}))
		.child(
			div()
				.whitespace_nowrap()
				.overflow_hidden()
				.text_ellipsis()
				.child(text),
		)
}

/// The layer drawn over the composer's float while files are dragged across
/// it: an accent wash, a glyph and one line naming what may be dropped.
pub fn drop_target(geometry: &ComposerSurfaceTokens, tokens: &TokenSet) -> Stateful<Div> {
	let mut wash = tokens.color(ColorRole::Accent);
	wash.a = 0.06;
	div()
		.id("composer-drop-target")
		.absolute()
		.inset_0()
		.rounded(px(geometry.radius_outer))
		.bg(wash)
		.flex()
		.flex_col()
		.items_center()
		.justify_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(
			Icon::new(IconName::Image)
				.size(IconSize::Size20)
				.color(tokens.color(ColorRole::Accent)),
		)
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Body))
				.line_height(tokens.line_height(TextRamp::Body))
				.font_weight(FontWeight::MEDIUM)
				.text_color(tokens.color(ColorRole::Foreground))
				.child("Drop images, video or UTF-8 text"),
		)
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Secondary))
				.child(accepted_line()),
		)
}

/// `PNG, JPEG, GIF, WebP · MP4, WebM, MOV`, from the accepted set itself.
fn accepted_line() -> String {
	let spell = |kind: MediaKind| {
		MediaType::iter()
			.filter(|media| media.kind() == kind)
			.map(|media| media.spelling())
			.collect::<Vec<_>>()
			.join(", ")
	};
	format!(
		"{} · {} · UTF-8 text · other files: preview only",
		spell(MediaKind::Image),
		spell(MediaKind::Video)
	)
}
