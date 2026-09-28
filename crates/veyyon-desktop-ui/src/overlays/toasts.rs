//! Short notices stacked in the bottom-right corner of the window.

use std::{rc::Rc, time::Duration};

use veyyon_gpui::{
	App, ClickEvent, Context, EventEmitter, IntoElement, Render, SharedString, Task, Window, div,
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

/// Emitted when the stack takes a toast down itself.
///
/// Its close button was clicked or its time ran out. [`Toasts::dismiss`]
/// emits nothing, and neither does a toast dropped for a newer one past
/// [`Toasts::LIMIT`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ToastDismissed(pub ToastId);

type ActionHandler = Rc<dyn Fn(&mut Window, &mut App)>;

/// A notice with an optional action button.
#[derive(Clone)]
pub struct Toast {
	kind:    ToastKind,
	message: SharedString,
	action:  Option<(SharedString, ActionHandler)>,
	lasts:   Option<Duration>,
}

impl Toast {
	/// A toast of `kind` showing `message`, which lasts
	/// [`Toasts::DISMISS_AFTER`].
	pub fn new(kind: ToastKind, message: impl Into<SharedString>) -> Self {
		Self { kind, message: message.into(), action: None, lasts: Some(Toasts::DISMISS_AFTER) }
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

	/// Keeps the toast up for `lasts` after it appears, or until it is
	/// dismissed when `None`.
	pub const fn lasts(mut self, lasts: Option<Duration>) -> Self {
		self.lasts = lasts;
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
	expiry:  Option<Task<()>>,
	/// Taken down and fading out: drawn, not listed.
	leaving: bool,
}

/// A stack of at most [`Toasts::LIMIT`] toasts, newest at the bottom.
///
/// A pushed toast fades in while rising [`motion::REVEAL_RISE`] under
/// [`motion::REVEAL`]; a fourth toast drops the oldest. A toast taken down
/// fades out while sinking under the same motion, and goes at once under
/// reduced motion. A toast with a lifetime ([`Toast::lasts`]) dismisses
/// itself that long after it appears through one scheduled task; hovering the
/// stack cancels those tasks and leaving it schedules them again. Render the
/// entity as the last child of a relatively positioned root: it positions
/// itself in the bottom-right corner.
#[derive(Default)]
pub struct Toasts {
	entries: Vec<Entry>,
	next:    usize,
	paused:  bool,
	driver:  MotionDriver,
}

impl EventEmitter<ToastDismissed> for Toasts {}

impl Toasts {
	/// Time a toast stays before it dismisses itself, unless [`Toast::lasts`]
	/// sets another.
	pub const DISMISS_AFTER: Duration = Duration::from_secs(5);
	/// Most toasts shown at once.
	pub const LIMIT: usize = 3;

	/// An empty stack.
	pub fn new() -> Self {
		Self::default()
	}

	/// Shows `toast` below the others, dropping the oldest when the stack is
	/// full.
	pub fn push(&mut self, toast: Toast, cx: &mut Context<Self>) -> ToastId {
		let mut excess = (self.live().count() + 1).saturating_sub(Self::LIMIT);
		self.entries.retain(|entry| {
			if entry.leaving || excess == 0 {
				return true;
			}
			excess -= 1;
			false
		});
		let id = ToastId(self.next);
		self.next += 1;
		let mut reveal = Animator::at_rest(0.0);
		drive(&mut reveal, 1.0, motion::REVEAL, cx);
		let expiry = if self.paused {
			None
		} else {
			Self::expire_later(id, toast.lasts, cx)
		};
		self
			.entries
			.push(Entry { id, toast, reveal, expiry, leaving: false });
		cx.notify();
		id
	}

	/// Takes the toast `id` down without emitting [`ToastDismissed`]. Does
	/// nothing when it is gone. An emptied stack is no longer hovered, so it
	/// stops pausing.
	pub fn dismiss(&mut self, id: ToastId, cx: &mut Context<Self>) {
		self.take_down(id, cx);
	}

	/// Stops the toasts from dismissing themselves while `paused`; resuming
	/// gives each toast its full time again.
	pub fn pause(&mut self, paused: bool, cx: &mut Context<Self>) {
		if self.paused == paused {
			return;
		}
		self.paused = paused;
		for entry in self.entries.iter_mut().filter(|entry| !entry.leaving) {
			entry.expiry = if paused {
				None
			} else {
				Self::expire_later(entry.id, entry.toast.lasts, cx)
			};
		}
	}

	/// The shown toasts, oldest first. A toast fading out is not shown.
	pub fn toasts(&self) -> impl Iterator<Item = (ToastId, &Toast)> {
		self.live().map(|entry| (entry.id, &entry.toast))
	}

	/// The opacity the next frame draws the toast `id` with, its exit
	/// included, or `None` once nothing of it is drawn.
	pub fn opacity(&self, id: ToastId, cx: &App) -> Option<f32> {
		let now = cx.frame_instant();
		self
			.entries
			.iter()
			.find(|entry| entry.id == id)
			.map(|entry| entry.reveal.sample(now).value)
	}

	fn live(&self) -> impl Iterator<Item = &Entry> {
		self.entries.iter().filter(|entry| !entry.leaving)
	}

	/// Starts the exit of the shown toast `id`, reporting whether one was
	/// shown.
	fn take_down(&mut self, id: ToastId, cx: &mut Context<Self>) -> bool {
		let Some(entry) = self
			.entries
			.iter_mut()
			.find(|entry| entry.id == id && !entry.leaving)
		else {
			return false;
		};
		entry.leaving = true;
		entry.expiry = None;
		drive(&mut entry.reveal, 0.0, motion::REVEAL, cx);
		self.settle();
		let live = self.live().next().is_some();
		self.paused &= live;
		cx.notify();
		true
	}

	/// Takes the toast `id` down on the stack's own account and reports it.
	fn close(&mut self, id: ToastId, cx: &mut Context<Self>) {
		if self.take_down(id, cx) {
			cx.emit(ToastDismissed(id));
		}
	}

	/// Drops the toasts whose exit has finished.
	fn settle(&mut self) {
		self
			.entries
			.retain(|entry| !(entry.leaving && entry.reveal.is_at_rest()));
	}

	fn expire_later(id: ToastId, lasts: Option<Duration>, cx: &Context<Self>) -> Option<Task<()>> {
		let lasts = lasts?;
		Some(cx.spawn(async move |this, cx| {
			cx.background_executor().timer(lasts).await;
			this.update(cx, |this, cx| this.close(id, cx)).ok();
		}))
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
			.child(
				div()
					.flex_none()
					.mt(space::S1_5)
					.size(space::S1_5)
					.rounded(radius::FULL)
					.bg(dot),
			)
			.child(
				div()
					.flex_1()
					.text_color(palette.text.primary)
					.child(entry.toast.message.clone()),
			)
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
					.debug_selector(|| "toast-close".to_owned())
					.flex_none()
					.px(space::S0_5)
					.rounded(radius::SM)
					.text_color(palette.text.muted)
					.cursor_pointer()
					.hover(|style| style.bg(palette.bg.hover).text_color(palette.text.primary))
					.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.close(id, cx)))
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
		self.settle();
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
			.children(
				self
					.entries
					.iter()
					.map(|entry| Self::render_entry(entry, &palette, cx)),
			)
			.into_any_element()
	}
}
