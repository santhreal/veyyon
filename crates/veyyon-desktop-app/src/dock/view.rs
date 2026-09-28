//! How the dock is laid out: the console and the goal over the card of the
//! decision waiting first, in a column no wider than the transcript's, the
//! card rising into place when it arrives and folded to one line by Esc.

use gpui::{AnyElement, Context, IntoElement, Render, SharedString, Window, div, prelude::*};
use veyyon_desktop_model::HostActionKind;
use veyyon_desktop_ui::{
	controls::{Button, ButtonSize, ButtonVariant, IconButton},
	icons::IconName,
	theme::{ActiveTheme, TypeStyled, motion, radius, size, space, text},
};

use super::{
	InteractionDock, KEY_CONTEXT,
	card::{Owned, Shown, first_line, plan_title, waiting_line},
};
use crate::{composer::measure::measure, driver};

/// The kind of decision a card answers, as its header states it.
const fn kind(decision: &Owned) -> &'static str {
	match decision {
		Owned::Approval(_) => "Approval needed",
		Owned::Question(_) => "Question",
		Owned::Plan(_) => "Plan review",
		Owned::Dialog(dialog) if dialog.questions.len() > 1 => "Questions",
		Owned::Dialog(_) => "Question",
	}
}

/// The line a folded card is drawn as.
fn subject(decision: &Owned) -> String {
	match decision {
		Owned::Approval(approval) => format!("Run {}?", approval.tool_name),
		Owned::Question(question) => first_line(&question.prompt).to_owned(),
		Owned::Plan(plan) => plan_title(&plan.markdown_plan),
		Owned::Dialog(dialog) => match dialog.questions.as_slice() {
			[only] => first_line(&only.question).to_owned(),
			many => format!("{} questions", many.len()),
		},
	}
}

/// Whether the card answers through a row of buttons: an approval, a plan,
/// and a question answered in the composer. Options and dialogs answer
/// through their own rows.
const fn has_buttons(decision: &Owned) -> bool {
	match decision {
		Owned::Approval(_) | Owned::Plan(_) => true,
		Owned::Question(question) => question.options.is_empty(),
		Owned::Dialog(_) => false,
	}
}

impl Render for InteractionDock {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		self.renders += 1;
		let mut frame = self.driver.begin(cx);
		frame.track(&mut self.reveal);
		self.driver.end(frame, window);
		let rise = self.reveal.value().clamp(0.0, 1.0);
		let console = self.render_console(window, cx);
		let goal = self.render_goal(cx);
		let card = self.render_card(rise, window, cx);
		let empty = console.is_none() && goal.is_none() && card.is_none();
		let column = div()
			.flex()
			.flex_col()
			.gap(space::S2)
			.w_full()
			.max_w(size::COLUMN_MAX)
			.mx_auto()
			.children(console)
			.children(goal)
			.children(card);
		let element = Self::listen(
			div()
				.id("dock")
				.key_context(KEY_CONTEXT)
				.track_focus(&self.focus),
			cx,
		)
		.w_full()
		.when(!empty, |dock| dock.px(space::S6).pb(space::S2))
		.child(column);
		measure(div().child(driver::target("dock", element)), cx)
	}
}

impl InteractionDock {
	/// The card of the decision waiting first, or `None` while none waits.
	fn render_card(
		&self,
		rise: f32,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> Option<AnyElement> {
		let shown = self.shown.as_ref()?;
		let waiting: Vec<String> = self
			.decisions(cx)
			.iter()
			.skip(1)
			.map(waiting_line)
			.collect();
		let blocked = self
			.app
			.read(cx)
			.refusal(HostActionKind::RespondToInteraction);
		let palette = cx.theme().palette;
		let frame = div()
			.id("dock-card")
			.relative()
			.top(motion::REVEAL_RISE * (1.0 - rise))
			.opacity(rise)
			.flex()
			.flex_col()
			.rounded(radius::XL)
			.border_1()
			.border_color(palette.border.default)
			.bg(palette.bg.surface)
			.type_style(text::UI)
			.text_color(palette.text.secondary);
		if shown.folded {
			return Some(Self::render_folded(shown, waiting.len(), frame, cx));
		}
		let body = match &shown.decision {
			Owned::Approval(approval) => Self::render_approval(approval, window, cx),
			Owned::Question(question) => {
				let choices = shown.decision.choices();
				self.render_question(question, &choices, blocked.is_some(), window, cx)
			},
			Owned::Plan(plan) => self.render_plan(plan, window, cx),
			Owned::Dialog(dialog) => match &shown.dialog {
				Some(state) => self.render_dialog(dialog, state, blocked.is_some(), window, cx),
				None => div().into_any_element(),
			},
		};
		let buttons =
			has_buttons(&shown.decision).then(|| Self::render_buttons(shown, blocked.is_some(), cx));
		let refused = shown.refused.then(|| {
			div()
				.type_style(text::SMALL)
				.text_color(palette.status.error)
				.child("The host did not take this answer. Answer it again.")
		});
		let reason = blocked.map(|reason| {
			div()
				.type_style(text::SMALL)
				.text_color(palette.text.faint)
				.child(reason)
		});
		let card = frame
			.gap(space::S3)
			.p(space::S3)
			.child(self.render_header(shown, &waiting, cx))
			.child(body)
			.children(refused)
			.children(reason)
			.children(buttons);
		Some(card.into_any_element())
	}

	/// The kind of decision, how many more wait and the fold control, with
	/// the waiting decisions listed under it when opened.
	fn render_header(&self, shown: &Shown, waiting: &[String], cx: &Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		let more = (!waiting.is_empty()).then(|| {
			let label = SharedString::from(format!("{} more waiting", waiting.len()));
			Button::new("dock-more", label)
				.variant(ButtonVariant::Ghost)
				.size(ButtonSize::Sm)
				.on_click(cx.listener(|this, _, _, cx| {
					this.more_open = !this.more_open;
					cx.notify();
				}))
		});
		let line = div()
			.flex()
			.items_center()
			.gap(space::S2)
			.child(
				div()
					.flex_1()
					.min_w_0()
					.type_style(text::SMALL)
					.text_color(palette.text.muted)
					.child(kind(&shown.decision)),
			)
			.children(more)
			.child(
				IconButton::new("dock-fold", IconName::ChevronDown)
					.tooltip("Fold (Esc)")
					.on_click(cx.listener(|this, _, window, cx| this.dismiss(window, cx))),
			);
		let list = (self.more_open && !waiting.is_empty()).then(|| {
			div()
				.flex()
				.flex_col()
				.gap(space::S0_5)
				.pl(space::S2)
				.border_l_1()
				.border_color(palette.border.subtle)
				.type_style(text::SMALL)
				.text_color(palette.text.muted)
				.children(
					waiting
						.iter()
						.map(|line| div().truncate().child(line.clone())),
				)
		});
		div()
			.flex()
			.flex_col()
			.gap(space::S2)
			.child(line)
			.children(list)
			.into_any_element()
	}

	/// The card's answers as buttons, 1 the leftmost, the one the keyboard is
	/// on ringed.
	fn render_buttons(shown: &Shown, blocked: bool, cx: &Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		let buttons = shown
			.decision
			.choices()
			.into_iter()
			.enumerate()
			.map(|(index, choice)| {
				let ring = if shown.cursor == Some(index) {
					palette.accent.focus_ring
				} else {
					gpui::transparent_black()
				};
				div()
					.rounded(radius::LG)
					.border_1()
					.border_color(ring)
					.child(
						Button::new(("dock-choice", index), choice.label)
							.variant(choice.variant)
							.size(ButtonSize::Sm)
							.disabled(blocked)
							.on_click(
								cx.listener(move |this, _, window, cx| this.pick(index, window, cx)),
							),
					)
			});
		div()
			.flex()
			.flex_wrap()
			.items_center()
			.gap(space::S1)
			.children(buttons)
			.into_any_element()
	}

	/// The folded card: its kind and subject on one line, opened by a click.
	fn render_folded(
		shown: &Shown,
		waiting: usize,
		frame: gpui::Stateful<gpui::Div>,
		cx: &Context<Self>,
	) -> AnyElement {
		let palette = cx.theme().palette;
		let count = (waiting > 0).then(|| {
			div()
				.flex_none()
				.type_style(text::SMALL)
				.text_color(palette.text.muted)
				.child(format!("+{waiting}"))
		});
		frame
			.flex_row()
			.items_center()
			.gap(space::S2)
			.px(space::S3)
			.py(space::S2)
			.cursor_pointer()
			.hover(|style| style.bg(palette.bg.hover))
			.on_click(cx.listener(|this, _, window, cx| this.unfold(window, cx)))
			.child(
				div()
					.flex_none()
					.type_style(text::SMALL)
					.text_color(palette.status.waiting)
					.child(kind(&shown.decision)),
			)
			.child(
				div()
					.flex_1()
					.min_w_0()
					.truncate()
					.text_color(palette.text.primary)
					.child(subject(&shown.decision)),
			)
			.children(count)
			.into_any_element()
	}
}
