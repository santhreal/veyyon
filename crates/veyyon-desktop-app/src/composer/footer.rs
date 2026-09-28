//! The row under the draft: the mode, model and thinking pickers, the serving
//! login, attach, dictation, history, the plan tally, the context meter, the
//! queue mode, stop and the primary control.
//!
//! A control whose action the host does not take now is drawn disabled, with
//! the host's reason as its tooltip.

use gpui::{AnyElement, App, Context, Div, ElementId, SharedString, Stateful, div, prelude::*};
use veyyon_desktop_model::{HostActionKind, QueueMode};
use veyyon_desktop_ui::{
	controls::{IconButton, Kbd, Tooltip},
	icons::{Icon, IconName},
	theme::{ActiveTheme, TypeStyled, radius, size, space, text},
};

use super::{Composer, Primary};
use crate::{driver, keymap};

/// A text chip that opens a picker: `label`, then a chevron.
fn chip(
	id: impl Into<ElementId>,
	label: impl Into<SharedString>,
	refusal: Option<String>,
	cx: &App,
) -> Stateful<Div> {
	let palette = cx.theme().palette;
	let disabled = refusal.is_some();
	let label = label.into();
	let tip = refusal.map_or_else(|| label.clone(), Into::into);
	div()
		.id(id)
		.flex()
		.items_center()
		.gap(space::S1)
		.h(size::CONTROL_SM)
		.px(space::S2)
		.min_w_0()
		.rounded(radius::MD)
		.type_style(text::SMALL)
		.text_color(if disabled {
			palette.text.faint
		} else {
			palette.text.secondary
		})
		.when(!disabled, |chip| {
			chip
				.cursor_pointer()
				.hover(|style| style.bg(palette.bg.hover))
		})
		.child(div().min_w_0().truncate().child(label))
		.child(
			Icon::new(IconName::ChevronDown)
				.size(size::ICON_SM)
				.color(palette.text.muted),
		)
		.tooltip(Tooltip::text(tip))
}

/// The keystrokes the keymap binds `action` to, as a key cap.
fn shortcut(action: &str) -> Option<Kbd> {
	keymap::default_binding(action).and_then(|keys| Kbd::chord(keys).ok())
}

/// A tokens figure as it is read: `850`, `12.4k`, `1.2M`.
pub fn tokens(count: u64) -> String {
	match count {
		0..1_000 => count.to_string(),
		1_000..1_000_000 => format!("{:.1}k", count as f64 / 1_000.0),
		_ => format!("{:.1}M", count as f64 / 1_000_000.0),
	}
}

impl Composer {
	/// The footer row.
	pub(super) fn render_footer(&self, cx: &Context<Self>) -> AnyElement {
		let leading = div()
			.flex()
			.flex_1()
			.min_w_0()
			.items_center()
			.gap(space::S1)
			.ml(-space::S1)
			.child(self.render_mode_chip(cx))
			.child(self.render_model_chip(cx))
			.children(self.render_serving(cx))
			.children(self.render_thinking_chip(cx))
			.child(self.render_tools(cx))
			.children(self.render_todo(cx));
		let trailing = div()
			.flex()
			.flex_none()
			.items_center()
			.gap(space::S1)
			.children(self.render_context(cx))
			.children(self.render_queue_mode(cx))
			.children(self.render_stop(cx))
			.child(self.render_primary(cx));
		div()
			.id("composer-footer")
			.flex()
			.items_center()
			.justify_between()
			.gap(space::S2)
			.child(leading)
			.child(trailing)
			.into_any_element()
	}

	fn render_mode_chip(&self, cx: &Context<Self>) -> AnyElement {
		let store = self.app.read(cx).store();
		let session = self.session.as_ref();
		let goal = session.and_then(|session| store.goals.get(session));
		let mode = session.and_then(|session| store.modes.get(session));
		let label = goal.map_or_else(
			|| mode.map_or_else(|| "Chat".to_owned(), |mode| mode.label().to_owned()),
			|goal| goal.chip_text(),
		);
		let refusal = self.refusal(HostActionKind::SetSessionMode, cx);
		let button = chip("composer-mode", label, refusal.clone(), cx)
			.when(refusal.is_none(), |chip| {
				chip.on_click(cx.listener(|this, _, window, cx| this.open_modes(window, cx)))
			});
		driver::target("composer.mode", button)
	}

	fn render_model_chip(&self, cx: &Context<Self>) -> AnyElement {
		let label = self
			.app
			.read(cx)
			.store()
			.domains
			.models
			.as_ref()
			.and_then(|models| {
				let current = models.current.as_ref()?;
				let model = models
					.models
					.iter()
					.find(|model| model.provider == current.provider && model.id == current.id);
				Some(model.map_or_else(|| current.id.clone(), |model| model.name.clone()))
			})
			.unwrap_or_else(|| "Select model".to_owned());
		let refusal = self.refusal(HostActionKind::SelectModel, cx);
		chip("composer-model", label, refusal.clone(), cx)
			.when(refusal.is_none(), |chip| {
				chip.on_click(cx.listener(|this, _, window, cx| this.open_models(window, cx)))
			})
			.into_any_element()
	}

	/// The login serving the session, when the provider stores more than one.
	fn render_serving(&self, cx: &App) -> Option<AnyElement> {
		let session = self.session.as_ref()?;
		let account = self
			.app
			.read(cx)
			.store()
			.domains
			.serving
			.get(session)
			.filter(|account| account.logins >= 2)?;
		let palette = cx.theme().palette;
		let (ink, tip) = if account.predicted {
			(palette.text.faint, format!("Next login: {}", account.label))
		} else {
			(palette.text.muted, format!("Serving login: {}", account.label))
		};
		Some(
			div()
				.id("composer-serving")
				.min_w_0()
				.truncate()
				.type_style(text::SMALL)
				.text_color(ink)
				.child(account.label.clone())
				.tooltip(Tooltip::text(tip))
				.into_any_element(),
		)
	}

	fn render_thinking_chip(&self, cx: &Context<Self>) -> Option<AnyElement> {
		let level = self
			.app
			.read(cx)
			.store()
			.domains
			.models
			.as_ref()
			.and_then(|models| {
				(!models.thinking_levels.is_empty()).then(|| {
					models
						.thinking_level
						.clone()
						.unwrap_or_else(|| "default".to_owned())
				})
			})?;
		let refusal = self.refusal(HostActionKind::SetThinkingLevel, cx);
		Some(
			chip("composer-thinking", format!("Thinking: {level}"), refusal.clone(), cx)
				.when(refusal.is_none(), |chip| {
					chip.on_click(cx.listener(|this, _, window, cx| this.open_thinking(window, cx)))
				})
				.into_any_element(),
		)
	}

	/// Attach, dictation and history.
	fn render_tools(&self, cx: &Context<Self>) -> AnyElement {
		let dictating = self
			.dictation(cx)
			.is_some_and(|view| view.state.is_active());
		let dictation_refusal = self.refusal(HostActionKind::ToggleDictation, cx);
		let history_refusal = self.refusal(HostActionKind::SearchPromptHistory, cx);
		let attach = IconButton::new("composer-attach", IconName::Paperclip)
			.tooltip("Attach files")
			.on_click(cx.listener(|_, _, _, cx| Self::attach_files(cx)));
		let attach = match shortcut("composer::AttachFiles") {
			Some(kbd) => attach.shortcut(kbd),
			None => attach,
		};
		let dictate = IconButton::new("composer-dictate", IconName::Mic)
			.selected(dictating)
			.disabled(dictation_refusal.is_some())
			.tooltip(dictation_refusal.unwrap_or_else(|| {
				if dictating {
					"Stop dictation"
				} else {
					"Dictate"
				}
				.to_owned()
			}))
			.on_click(cx.listener(|this, _, _, cx| this.toggle_dictation(cx)));
		let history = IconButton::new("composer-history", IconName::History)
			.disabled(history_refusal.is_some())
			.tooltip(history_refusal.unwrap_or_else(|| "Search earlier prompts".to_owned()))
			.on_click(cx.listener(|this, _, window, cx| this.search_history(window, cx)));
		div()
			.flex()
			.items_center()
			.child(attach)
			.child(dictate)
			.child(history)
			.into_any_element()
	}

	/// The plan the session works, as its tally and phase.
	fn render_todo(&self, cx: &App) -> Option<AnyElement> {
		let session = self.session.as_ref()?;
		let board = self.app.read(cx).store().domains.todo.get(session)?;
		let palette = cx.theme().palette;
		let tip = board.current.as_ref().map_or_else(
			|| "Plan finished".to_owned(),
			|task| format!("Working on: {}", task.content),
		);
		Some(
			div()
				.id("composer-todo")
				.flex()
				.items_center()
				.gap(space::S1)
				.min_w_0()
				.type_style(text::SMALL)
				.text_color(palette.text.muted)
				.child(
					Icon::new(IconName::ListTodo)
						.size(size::ICON_SM)
						.color(palette.text.muted),
				)
				.child(div().min_w_0().truncate().child(board.chip_text()))
				.tooltip(Tooltip::text(tip))
				.into_any_element(),
		)
	}

	/// The share of the context window the session fills.
	fn render_context(&self, cx: &App) -> Option<AnyElement> {
		let session = self.session.as_ref()?;
		let breakdown = self.app.read(cx).store().domains.context.get(session)?;
		let palette = cx.theme().palette;
		let (label, tip) = match breakdown.limit_tokens.filter(|limit| *limit > 0) {
			Some(limit) => {
				let share = breakdown.total_tokens.saturating_mul(100) / limit;
				(
					format!("{share}%"),
					format!("Context: {} of {} tokens", tokens(breakdown.total_tokens), tokens(limit)),
				)
			},
			None => (
				tokens(breakdown.total_tokens),
				format!("Context: {} tokens", tokens(breakdown.total_tokens)),
			),
		};
		Some(
			div()
				.id("composer-context")
				.px(space::S1)
				.type_style(text::SMALL)
				.text_color(palette.text.muted)
				.child(label)
				.tooltip(Tooltip::text(tip))
				.into_any_element(),
		)
	}

	/// Whether a prompt sent during the turn steers it or queues behind it.
	fn render_queue_mode(&self, cx: &Context<Self>) -> Option<AnyElement> {
		if !self.running {
			return None;
		}
		let refusal = self.refusal(HostActionKind::SetQueueMode, cx);
		let label = match self.queue_mode {
			QueueMode::Steer => "Steer",
			QueueMode::Queue => "Queue",
		};
		Some(
			chip("composer-queue-mode", label, refusal.clone(), cx)
				.when(refusal.is_none(), |chip| {
					chip.on_click(cx.listener(|this, _, _, cx| this.toggle_queue_mode(cx)))
				})
				.into_any_element(),
		)
	}

	/// Stop, beside a primary control that sends into the running turn.
	fn render_stop(&self, cx: &Context<Self>) -> Option<AnyElement> {
		if !self.running || self.shape.1 == Primary::Stop {
			return None;
		}
		let stop = IconButton::new("composer-stop", IconName::Square)
			.tooltip(Primary::Stop.label())
			.on_click(cx.listener(|this, _, _, cx| this.stop(cx)));
		Some(match shortcut("composer::Stop") {
			Some(kbd) => stop.shortcut(kbd).into_any_element(),
			None => stop.into_any_element(),
		})
	}

	/// Send, steer, queue, stop, answer, approve, accept or refine.
	fn render_primary(&self, cx: &Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		let (empty, primary) = self.shape;
		let refusal = self.refusal(primary.kind(), cx);
		let needs_text = matches!(
			primary,
			Primary::Send | Primary::Steer | Primary::Queue | Primary::Answer | Primary::Refine
		);
		let idle = refusal.is_some() || (needs_text && empty && self.attachments.is_empty());
		let (fill, ink) = if idle {
			(palette.bg.hover, palette.text.faint)
		} else {
			(palette.accent.base, palette.accent.fg)
		};
		let tip = refusal.unwrap_or_else(|| primary.label().to_owned());
		div()
			.id("composer-primary")
			.flex()
			.flex_none()
			.items_center()
			.justify_center()
			.size(size::CONTROL)
			.rounded(radius::FULL)
			.bg(fill)
			.when(!idle, |button| {
				button
					.cursor_pointer()
					.on_click(cx.listener(move |this, _, _, cx| this.press(primary, cx)))
			})
			.child(Icon::new(primary.icon()).size(size::ICON).color(ink))
			.tooltip(Tooltip::text(tip))
			.into_any_element()
	}
}
