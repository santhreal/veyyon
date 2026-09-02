//! The tray of images and clips the next prompt carries (§5.4), and the
//! target the composer becomes while files are dragged over it.
//!
//! One card per attachment: a square thumbnail — the image itself, or a film
//! glyph on the inset ground for a clip — beside the file's name and its type
//! and size, with a remove control that appears on hover. A card whose media
//! the active model is not known to take says so in the accent, in the place
//! the size would go, rather than hiding the attachment or the fact.

use veyyon_desktop_kit::{
	ColorRole, Icon, IconButton, IconButtonVariant, IconName, IconSize, SpacingStep, StrokeStep,
	TextRamp, TokenSet,
};
use veyyon_desktop_tokens::ComposerSurfaceTokens;
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, Div, ElementId, FontWeight, InteractiveElement, IntoElement,
	ObjectFit, ParentElement, Stateful, Styled, StyledImage, div, img, px,
};

use super::{
	TurnPhase,
	media::{MediaKind, MediaType, Payload, human_bytes},
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
	let model = composer.model.as_ref().and_then(|model| model.label());
	div()
		.id("composer-attachments")
		.w_full()
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
					let unsupported = composer.unsupported(attachment).then_some(model).flatten();
					attachment_card(index, attachment, unsupported, geometry, tokens, cx)
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
) -> Stateful<Div> {
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
			format!("Not accepted by {model}"),
			ColorRole::Accent,
			tokens,
		),
		None => caption_row(None, size_caption(attachment), ColorRole::Secondary, tokens),
	};

	div()
		.id(ElementId::NamedInteger("composer-attachment".into(), index as u64))
		.group("composer-attachment")
		.relative()
		.h(px(geometry.attachment_card_height_px))
		.max_w(px(geometry.attachment_card_max_width_px))
		.rounded(px(geometry.attachment_card_radius))
		.border(tokens.stroke(StrokeStep::Hairline))
		.border_color(edge)
		.overflow_hidden()
		.flex()
		.flex_row()
		.items_center()
		.hover(move |style| style.bg(hover_wash))
		.child(thumbnail(attachment, geometry, tokens))
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
					IconButton::new(IconName::Close)
						.id(ElementId::NamedInteger("composer-attachment-remove".into(), index as u64))
						.size(IconSize::Size12)
						.variant(IconButtonVariant::Ghost)
						.on_click(cx.listener(move |view, _event: &ClickEvent, _window, cx| {
							view.dispatch(Intent::RemoveAttachment(index));
							cx.notify();
						})),
				),
		)
}

/// The square at the card's leading edge: the image, or a film glyph.
fn thumbnail(
	attachment: &Attachment,
	geometry: &ComposerSurfaceTokens,
	tokens: &TokenSet,
) -> AnyElement {
	let side = px(geometry.attachment_card_height_px);
	match &attachment.payload {
		Payload::Image(image) => img(image.clone())
			.w(side)
			.h(side)
			.flex_none()
			.object_fit(ObjectFit::Cover)
			.into_any_element(),
		Payload::Video(_) => div()
			.w(side)
			.h(side)
			.flex_none()
			.bg(tokens.color(ColorRole::Inset))
			.flex()
			.items_center()
			.justify_center()
			.child(
				Icon::new(IconName::Film)
					.size(IconSize::Size20)
					.color(tokens.color(ColorRole::Secondary)),
			)
			.into_any_element(),
	}
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
			IconButton::new(IconName::Close)
				.id("composer-attachment-notice-close")
				.size(IconSize::Size12)
				.variant(IconButtonVariant::Ghost)
				.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
					view.clear_composer_notice();
					cx.notify();
				})),
		)
}

/// `PNG · 820 KB`: the type in the operator's spelling, then the size.
fn size_caption(attachment: &Attachment) -> String {
	format!("{} · {}", attachment.media.spelling(), human_bytes(attachment.bytes()))
}

/// The card's second line, optionally led by a 12px glyph in the same ink.
fn caption_row(glyph: Option<IconName>, text: String, ink: ColorRole, tokens: &TokenSet) -> Div {
	div()
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.text_size(tokens.font_size(TextRamp::Micro))
		.line_height(tokens.line_height(TextRamp::Micro))
		.text_color(tokens.color(ink))
		.whitespace_nowrap()
		.overflow_hidden()
		.text_ellipsis()
		.children(glyph.map(|name| {
			Icon::new(name)
				.size(IconSize::Size12)
				.color(tokens.color(ink))
		}))
		.child(text)
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
				.child("Drop images or video"),
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
		MediaType::ALL
			.iter()
			.filter(|media| media.kind() == kind)
			.map(|media| media.spelling())
			.collect::<Vec<_>>()
			.join(", ")
	};
	format!("{} · {}", spell(MediaKind::Image), spell(MediaKind::Video))
}
