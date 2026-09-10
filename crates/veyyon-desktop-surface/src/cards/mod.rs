//! Attached cards: approval, question and plan (§5.3).
//!
//! These are the surfaces that make this a control surface rather than a
//! transcript viewer. A run that needs a decision does not bury the request in
//! scrollback where it competes with output; it attaches a card directly above
//! the composer, where the operator is already looking and already typing.
//!
//! The stack is capped. Three sessions asking at once is a queue of decisions,
//! not three stacked dialogs, so past the cap the rest collapse to one row that
//! states how many are waiting. An operator who cannot see the composer cannot
//! answer anything.
//!
//! One file per card kind, and one for the answer row they share: a card kind
//! is a contract with the host, and the shell and the answer row are the two
//! things every kind draws the same way.

mod answers;
mod approval;
mod plan;
mod question;

use veyyon_desktop_kit::{
	ColorRole, RadiusStep, SpacingStep, StrokeStep, TextRamp, TintRole, TokenSet,
};
use veyyon_desktop_tokens::AttachedCardsSurfaceTokens;
use veyyon_gpui::{
	AnyElement, Context, Div, FocusHandle, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div, px,
};

use self::{approval::approval, plan::plan, question::question};
use crate::{
	ShellView,
	model::{Card, CardAnswers},
};

/// Builds the attached card stack, capped at the token's visible count.
///
/// `overflow_focus` is the handle the collapsed overflow row tracks and
/// `expanded` states whether the pointer or the keyboard is on it, so the
/// count it carries expands for either (§5.5).
///
/// `answers` is what each kind of decision can be answered with right now, so
/// a card whose answer the host cannot take draws its rows unanswerable
/// rather than offering a press that reaches nothing.
pub fn card_stack(
	cards: &[Card],
	answers: &CardAnswers,
	geometry: &AttachedCardsSurfaceTokens,
	tokens: &TokenSet,
	overflow_focus: &FocusHandle,
	expanded: bool,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let mut stack = div()
		.flex()
		.flex_col()
		.w_full()
		.gap(tokens.spacing(SpacingStep::S2));

	let visible = geometry.stack_max_visible.min(cards.len());
	for (index, card) in cards.iter().enumerate().take(visible) {
		let answer = answers.of(card);
		let body: AnyElement = match card {
			Card::Approval { tool, detail } => {
				approval(index, tool, detail, answer, geometry, tokens, cx).into_any_element()
			},
			Card::Question { prompt, options } => {
				question(index, prompt, options, answer, geometry, tokens, cx).into_any_element()
			},
			Card::Plan { title, body } => {
				plan(index, title, body, answer, geometry, tokens, cx).into_any_element()
			},
		};

		// The card's position identifies it, so a control inside it needs only
		// a position of its own. The two compose into one identity per control,
		// which is what keeps two cards offering "Approve" distinguishable.
		stack = stack.child(div().id(("card", index)).w_full().child(body));
	}

	let hidden = &cards[visible..];
	if !hidden.is_empty() {
		// One line per waiting decision, plus the count's own. The collapsed
		// height clips them until the pointer or the keyboard is on the row:
		// the count states how many are waiting, and the expansion states
		// which, because a queue of decisions an operator cannot read is a
		// number rather than a queue.
		//
		// The height comes from the state and not from a `hover` refinement,
		// which resolves at paint and cannot change a box: the pointer's
		// arrival is recorded, and the frame after it lays the row out open.
		let line = geometry.stack_overflow_collapsed_height_px;
		let open = line * (1 + hidden.len()) as f32;
		let mut row = div()
			.id("card-stack-overflow")
			.track_focus(overflow_focus)
			.h(px(if expanded { open } else { line }))
			.on_hover(cx.listener(|view, hovered: &bool, _window, cx| {
				if view.set_cards_hovered(*hovered) {
					cx.notify();
				}
			}))
			.w_full()
			.overflow_hidden()
			.flex()
			.flex_col()
			.px(tokens.spacing(SpacingStep::S3))
			.rounded(tokens.radius(RadiusStep::Md))
			.bg(tokens.color(ColorRole::Inset))
			.text_size(tokens.font_size(TextRamp::Micro))
			.line_height(tokens.line_height(TextRamp::Micro))
			.text_color(tokens.color(ColorRole::Muted))
			.child(
				div()
					.h(px(line))
					// The row is a clip, not a shrink. A flex child yields its
					// height by default, so a collapsed row of one line holding
					// three of them handed each a third of a line: a native take
					// photographed `1 more waiting` with the first folded name
					// cut through the middle of its glyphs underneath it. Every
					// line keeps the height the token authors and the row's own
					// `overflow_hidden` decides how many of them are seen.
					.flex_shrink_0()
					.flex()
					.items_center()
					.child(format!("{} more waiting", hidden.len())),
			);

		for card in hidden {
			row = row.child(
				div()
					.h(px(line))
					.flex_shrink_0()
					.w_full()
					.min_w_0()
					.flex()
					.items_center()
					.overflow_hidden()
					.whitespace_nowrap()
					.truncate()
					.text_color(tokens.color(ColorRole::Secondary))
					.child(waiting_line(card)),
			);
		}

		stack = stack.child(row);
	}

	stack
}

/// What one waiting decision states in the collapsed overflow row: the kind,
/// and the subject that tells two of a kind apart.
fn waiting_line(card: &Card) -> String {
	match card {
		Card::Approval { tool, .. } => format!("Approval: {tool}"),
		Card::Question { prompt, .. } => format!("Question: {prompt}"),
		Card::Plan { title, .. } => format!("Plan: {title}"),
	}
}

/// The shell every card shares: a tinted edge naming what kind of decision it
/// is, so the kind is readable before the text is.
fn shell(tint: TintRole, padding: f32, tokens: &TokenSet) -> Div {
	div()
		.w_full()
		.p(px(padding))
		.rounded(tokens.radius(RadiusStep::Md))
		.bg(tokens.color(ColorRole::Float))
		.border(tokens.stroke(StrokeStep::Hairline))
		.border_color(tokens.tint(tint).fill)
		.overflow_hidden()
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S2))
}
