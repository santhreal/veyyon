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

use veyyon_desktop_kit::{
	ColorRole, MonoSizeStep, RadiusStep, SpacingStep, StrokeStep, TextRamp, TextWeight, TintRole,
	TokenSet,
};
use veyyon_desktop_tokens::AttachedCardsSurfaceTokens;
use veyyon_gpui::{
	AnyElement, Context, Div, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div, px,
};

use crate::{ShellView, intent::Intent, model::Card};

/// Builds the attached card stack, capped at the token's visible count.
pub fn card_stack(
	cards: &[Card],
	geometry: &AttachedCardsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let mut stack = div()
		.flex()
		.flex_col()
		.w_full()
		.gap(tokens.spacing(SpacingStep::S2));

	let visible = geometry.stack_max_visible.min(cards.len());
	for (index, card) in cards.iter().enumerate().take(visible) {
		let body: AnyElement = match card {
			Card::Approval { tool, detail } => {
				approval(index, tool, detail, geometry, tokens, cx).into_any_element()
			},
			Card::Question { prompt, options } => {
				question(index, prompt, options, geometry, tokens, cx).into_any_element()
			},
			Card::Plan { title, body } => {
				plan(index, title, body, geometry, tokens, cx).into_any_element()
			},
		};

		// The card's position identifies it, so a control inside it needs only
		// a position of its own. The two compose into one identity per control,
		// which is what keeps two cards offering "Approve" distinguishable.
		stack = stack.child(div().id(("card", index)).w_full().child(body));
	}

	let hidden = cards.len().saturating_sub(visible);
	if hidden > 0 {
		stack = stack.child(
			div()
				.h(px(geometry.stack_overflow_collapsed_height_px))
				.w_full()
				.flex()
				.items_center()
				.px(tokens.spacing(SpacingStep::S3))
				.rounded(tokens.radius(RadiusStep::Md))
				.bg(tokens.color(ColorRole::Inset))
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child(format!("{hidden} more waiting")),
		);
	}

	stack
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

/// An approval: what the agent wants to run, and the two answers.
fn approval(
	card: usize,
	tool: &str,
	detail: &[String],
	geometry: &AttachedCardsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut pane = div()
		.w_full()
		.max_h(px(geometry.approval_detail_mono_pane_cap_px))
		.overflow_hidden()
		.rounded(tokens.radius(RadiusStep::Sm))
		.bg(tokens.color(ColorRole::Inset))
		.p(tokens.spacing(SpacingStep::S2))
		.flex()
		.flex_col();

	for line in detail {
		pane = pane.child(
			div()
				.w_full()
				.min_w_0()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.text_size(tokens.mono_font_size(MonoSizeStep::Small))
				.line_height(tokens.mono_line_height(MonoSizeStep::Small))
				.text_color(tokens.color(ColorRole::Secondary))
				.child(line.clone()),
		);
	}

	shell(TintRole::Approve, geometry.approval_padding, tokens)
		.child(
			div()
				.w_full()
				.min_w_0()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.text_size(px(geometry.approval_tool_name_size.size))
				.line_height(px(geometry.approval_tool_name_size.line_height))
				.font_weight(veyyon_gpui::FontWeight(f32::from(geometry.approval_tool_name_weight)))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(tool.to_owned()),
		)
		.child(pane)
		.child(answers(
			&[
				(
					"Reject",
					Choice::Fixed(Box::new(Intent::Approval { card, approved: false, standing: false })),
				),
				(
					"Approve for session",
					Choice::Fixed(Box::new(Intent::Approval { card, approved: true, standing: true })),
				),
				(
					"Approve",
					Choice::Fixed(Box::new(Intent::Approval { card, approved: true, standing: false })),
				),
			],
			tokens,
			cx,
		))
}

/// A question: what the agent is asking, and the answers it offers.
fn question(
	card: usize,
	prompt: &str,
	options: &[String],
	geometry: &AttachedCardsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut element = shell(TintRole::Input, geometry.question_padding, tokens).child(
		div()
			.w_full()
			.text_size(px(geometry.question_size.size))
			.line_height(px(geometry.question_size.line_height))
			.text_color(tokens.color(ColorRole::Foreground))
			.child(prompt.to_owned()),
	);

	// A question's options are its answers: the row is the control, not a list
	// above one, because an option an operator cannot click is a transcript of
	// the question rather than a way to answer it.
	for (option, label) in options.iter().enumerate() {
		let hover = tokens.row_hover();

		element = element.child(
			div()
				.id(("option", option))
				.on_click(cx.listener(move |view, _event, _window, cx| {
					view.dispatch(Intent::Answer { card, option }, cx);
				}))
				.hover(move |style| style.bg(hover))
				.h(px(geometry.question_option_row_height_px))
				.w_full()
				.flex()
				.items_center()
				.px(tokens.spacing(SpacingStep::S2))
				.rounded(tokens.radius(RadiusStep::Sm))
				.bg(tokens.color(ColorRole::Inset))
				.min_w_0()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Secondary))
				.child(label.clone()),
		);
	}

	// A question with no options is answered in prose. The composer is the
	// place the operator already types, so the answer is what it holds when
	// the row is clicked, and the card says so rather than growing a second
	// text field above the first.
	if options.is_empty() {
		element = element.child(answers(
			&[("Reply with the composer's text", Choice::Reply { card })],
			tokens,
			cx,
		));
	}

	element
}

/// What clicking an answer dispatches.
///
/// Most answers are decided when the card is drawn. A reply is not: its text
/// is whatever the composer holds at the click, so it is built then.
#[derive(Clone)]
enum Choice {
	Fixed(Box<Intent>),
	Reply { card: usize },
}

impl Choice {
	fn intent(&self, view: &ShellView) -> Intent {
		match self {
			Self::Fixed(intent) => intent.as_ref().clone(),
			Self::Reply { card } => {
				Intent::Reply { card: *card, text: view.composer_text().to_string() }
			},
		}
	}
}

/// A plan: what the agent intends, capped in height and faded at the cut.
fn plan(
	card: usize,
	title: &str,
	body: &[String],
	geometry: &AttachedCardsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut markdown = div()
		.w_full()
		.max_h(px(geometry.plan_max_markdown_height_px))
		.overflow_hidden()
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S1));

	for line in body {
		markdown = markdown.child(
			div()
				.w_full()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Secondary))
				.child(line.clone()),
		);
	}

	shell(TintRole::Plan, geometry.plan_padding, tokens)
		.child(
			div()
				.w_full()
				.min_w_0()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.text_size(tokens.font_size(TextRamp::Body))
				.line_height(tokens.line_height(TextRamp::Body))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(title.to_owned()),
		)
		.child(markdown)
		.child(answers(
			&[
				("Revise", Choice::Fixed(Box::new(Intent::Plan { card, accepted: false }))),
				("Accept", Choice::Fixed(Box::new(Intent::Plan { card, accepted: true }))),
			],
			tokens,
			cx,
		))
}

/// The answer row every card ends with. A decision surface that states the
/// question without offering the answers is a notification.
fn answers(choices: &[(&str, Choice)], tokens: &TokenSet, cx: &Context<ShellView>) -> Div {
	let mut row = div()
		.w_full()
		.flex()
		.flex_row()
		.justify_end()
		.gap(tokens.spacing(SpacingStep::S2));

	// The last choice is the affirmative one and carries the accent; the rest
	// are ink on hairline, so the default reading of the card is what it will
	// do. A neutral fill here would paint a second ground over the card's own.
	let last = choices.len().saturating_sub(1);
	for (index, (label, choice)) in choices.iter().enumerate() {
		let affirmative = index == last;
		let (ground, edge, ink, hover) = if affirmative {
			(
				tokens.color(ColorRole::Accent),
				tokens.transparent(),
				tokens.color(ColorRole::AccentForeground),
				tokens.color(ColorRole::Focus),
			)
		} else {
			(
				tokens.transparent(),
				tokens.color(ColorRole::Hairline),
				tokens.color(ColorRole::Secondary),
				tokens.row_hover(),
			)
		};
		let choice = choice.clone();

		row = row.child(
			div()
				.id(("choice", index))
				.on_click(cx.listener(move |view, _event, _window, cx| {
					let intent = choice.intent(view);
					view.dispatch(intent, cx);
				}))
				.hover(move |style| style.bg(hover))
				.flex_shrink_0()
				.px(tokens.spacing(SpacingStep::S3))
				.py(tokens.spacing(SpacingStep::S1))
				.rounded(tokens.radius(RadiusStep::Sm))
				.bg(ground)
				.border(tokens.stroke(StrokeStep::Hairline))
				.border_color(edge)
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(ink)
				.child((*label).to_owned()),
		);
	}

	row
}
