//! Short notices stacked in the bottom-right corner of the window.

use std::{rc::Rc, time::Duration};

use veyyon_gpui::{
	App, ClickEvent, Context, IntoElement, Render, SharedString, Task, Window, div,
	motion::{Animator, FrameInstant, MotionDriver},
	prelude::*,
};

use super::drive;
use crate::theme::{ActiveTheme, Palette, TypeStyled, motion, radius, size, space, text};

/// The tone of a toast, drawn as the color of its status dot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToastKind {
	/// Neutral information, `status.info`.
	Info,
	/// A finished operation, `status.success`.
	Success,
	/// A failure, `status.error`.
	Error,
}

/// Identity of a pushed toast.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ToastId(usize);

type ActionHandler = Rc<dyn Fn(&mut Window, &mut App)>;

/// A notice with an optional action button.
#[derive(Clone)]
pub struct Toast {
	kind:    ToastKind,
	message: SharedString,
	action:  Option<(SharedString, ActionHandler)>,
}

impl Toast {
	/// A toast of `kind` showing `message`.
	pub fn new(kind: ToastKind, message: impl Into<SharedString>) -> Self {
		Self { kind, message: message.into(), action: None }
	}

	/// Shows a button labelled `label` that calls `handler` when clicked.
	pub fn action(
		mut self,
		label: impl Into<SharedString>,
		handler: impl Fn(&mut Window, &mut App) + 'static,
	) -> Self {
		self.action = Some((label.into(), Rc::new(handler)));
		self
	}

	/// The toast's tone.
	pub const fn kind(&self) -> ToastKind {
		self.kind
	}

	/// The toast's message.
	pub const fn message(&self) -> &SharedString {
		&self.message
	}
}

struct Entry {
	id:      ToastId,
	toast:   Toast,
	reveal:  Animator<FrameInstant>,
	dismiss: Option<Task<()>>,
}

/// A stack of at most [`Toasts::LIMIT`] toasts, newest at the bottom.
///
/// A pushed toast fades in while rising [`motion::REVEAL_RISE`] under
/// [`motion::REVEAL`]; a fourth toast drops the oldest. Each toast dismisses
/// itself [`Toasts::DISMISS_AFTER`] after it appears through one scheduled
/// task; hovering the stack cancels those tasks and leaving it schedules them
/// again. Render the entity as the last child of a relatively positioned root:
/// it positions itself in the bottom-right corner.
#[derive(Default)]
pub struct Toasts {
	entries: Vec<Entry>,
	next:    usize,
	paused:  bool,
	driver:  MotionDriver,
}

impl Toasts {
	/// Most toasts shown at once.
	pub const LIMIT: usize = 3;
	/// Time a toast stays before it dismisses itself.
	pub const DISMISS_AFTER: Duration = Duration::from_secs(5);

	/// An empty stack.
	pub fn new() -> Self {
		Self::default()
	}

	/// Shows `toast` below the others, dropping the oldest when the stack is
	/// full.
	pub fn push(&mut self, toast: Toast, cx: &mut Context<Self>) -> ToastId {
		let excess = (self.entries.len() + 1).saturating_sub(Self::LIMIT);
		self.entries.drain(..excess);
		let id = ToastId(self.next);
		self.next += 1;
		let mut reveal = Animator::at_rest(0.0);
		drive(&mut reveal, 1.0, motion::REVEAL, cx);
		let dismiss = (!self.paused).then(|| Self::dismiss_later(id, cx));
		self.entries.push(Entry { id, toast, reveal, dismiss });
		cx.notify();
		id
	}

	/// Removes the toast `id`. Does nothing when it is gone. An emptied stack
	/// is no longer hovered, so it stops pausing.
	pub fn dismiss(&mut self, id: ToastId, cx: &mut Context<Self>) {
		let before = self.entries.len();
		self.entries.retain(|entry| entry.id != id);
		if self.entries.len() != before {
			self.paused &= !self.entries.is_empty();
			cx.notify();
		}
	}

	/// Stops the toasts from dismissing themselves while `paused`; resuming
	/// gives each toast its full time again.
	pub fn pause(&mut self, paused: bool, cx: &mut Context<Self>) {
		if self.paused == paused {
			return;
		}
		self.paused = paused;
		for entry in &mut self.entries {
			entry.dismiss = (!paused).then(|| Self::dismiss_later(entry.id, cx));
		}
	}

	/// The shown toasts, oldest first.
	pub fn toasts(&self) -> impl ExactSizeIterator<Item = (ToastId, &Toast)> {
		self.entries.iter().map(|entry| (entry.id, &entry.toast))
	}

	fn dismiss_later(id: ToastId, cx: &Context<Self>) -> Task<()> {
		cx.spawn(async move |this, cx| {
			cx.background_executor().timer(Self::DISMISS_AFTER).await;
			this.update(cx, |this, cx| this.dismiss(id, cx)).ok();
		})
	}

	fn render_entry(entry: &Entry, palette: &Palette, cx: &Context<Self>) -> impl IntoElement {
		let shown = entry.reveal.value();
		let dot = match entry.toast.kind {
			ToastKind::Info => palette.status.info,
			ToastKind::Success => palette.status.success,
			ToastKind::Error => palette.status.error,
		};
		let id = entry.id;
		div()
			.id(("toast", id.0))
			.relative()
			.top(motion::REVEAL_RISE * (1.0 - shown))
			.opacity(shown)
			.flex()
			.items_start()
			.gap(space::S2_5)
			.p(space::S3)
			.rounded(radius::LG)
			.bg(palette.bg.elevated)
			.border_1()
			.border_color(palette.border.default)
			.shadow_lg()
			.type_style(text::UI)
			.child(div().flex_none().mt(space::S1_5).size(space::S1_5).rounded(radius::FULL).bg(dot))
			.child(div().flex_1().text_color(palette.text.primary).child(entry.toast.message.clone()))
			.when_some(entry.toast.action.clone(), |el, (label, handler)| {
				el.child(
					div()
						.id(("toast-action", id.0))
						.flex_none()
						.type_style(text::UI_MEDIUM)
						.text_color(palette.accent.base)
						.cursor_pointer()
						.on_click(move |_: &ClickEvent, window, cx| handler(window, cx))
						.child(label),
				)
			})
			.child(
				div()
					.id(("toast-close", id.0))
					.flex_none()
					.px(space::S0_5)
					.rounded(radius::SM)
					.text_color(palette.text.muted)
					.cursor_pointer()
					.hover(|style| style.bg(palette.bg.hover).text_color(palette.text.primary))
					.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.dismiss(id, cx)))
					.child("\u{00d7}"),
			)
	}
}

impl Render for Toasts {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let mut frame = self.driver.begin(cx);
		for entry in &mut self.entries {
			frame.track(&mut entry.reveal);
		}
		self.driver.end(frame, window);
		if self.entries.is_empty() {
			return div().into_any_element();
		}
		let palette = cx.theme().palette;
		div()
			.id("toasts")
			.absolute()
			.bottom(space::S4)
			.right(space::S4)
			.flex()
			.flex_col()
			.gap(space::S2)
			.w(size::TOAST_WIDTH)
			.on_hover(cx.listener(|this, hovered: &bool, _, cx| this.pause(*hovered, cx)))
			.children(self.entries.iter().map(|entry| Self::render_entry(entry, &palette, cx)))
			.into_any_element()
	}
}
