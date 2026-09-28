//! The announcement stack drawn as the window's toasts.
//!
//! The notification queue in [`AppState`] is the single definition of every
//! announcement's lifetime. The workspace draws the most urgent
//! [`Toasts::LIMIT`] announcements as toasts that never time out on their own,
//! runs one timer to the queue's next deadline that expires the queue, and
//! takes an announcement off the queue when its toast's close button is
//! clicked. An export's toast offers to open the file the host wrote.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui::{AppContext as _, Context, Entity, Subscription, Task, WeakEntity};
use veyyon_desktop_model::{
	HostAction, HostActionKind, Notification, NotificationPriority, NotificationSource, SurfaceId,
};
use veyyon_desktop_ui::overlays::{Toast, ToastDismissed, ToastId, ToastKind, Toasts};

use super::Workspace;
use crate::AppState;

/// One announcement drawn as a toast, and whether it offers to open a file.
struct Shown {
	key:   String,
	title: String,
	kind:  ToastKind,
	opens: bool,
	id:    ToastId,
}

/// The toasts drawn for the announcement queue.
pub(super) struct Notices {
	toasts: Entity<Toasts>,
	shown:  Vec<Shown>,
	/// The queue deadline the timer runs to, and the timer.
	expiry: Option<(u64, Task<()>)>,
}

impl Notices {
	/// An empty stack, and the subscription that takes an announcement off
	/// the queue when the stack takes its toast down.
	pub(super) fn new(cx: &mut Context<Workspace>) -> (Self, Subscription) {
		let toasts = cx.new(|_| Toasts::new());
		let dismissed = cx.subscribe(&toasts, |this, _, event: &ToastDismissed, cx| {
			this.notices.dismissed(event.0, &this.app, cx);
		});
		(Self { toasts, shown: Vec::new(), expiry: None }, dismissed)
	}

	/// The toast stack.
	pub(super) const fn toasts(&self) -> &Entity<Toasts> {
		&self.toasts
	}

	/// Draws the queue of `app`: takes down the toasts whose announcement
	/// went or changed, or whose Open the host took or gave back, pushes the
	/// announcements not drawn yet, and runs the timer to the queue's next
	/// deadline.
	pub(super) fn sync(&mut self, app: &Entity<AppState>, cx: &mut Context<Workspace>) {
		let state = app.read(cx);
		let opens = state.refusal(HostActionKind::OpenExternal).is_none();
		let queue = &state.store().notifications;
		let next = queue
			.raised()
			.iter()
			.filter_map(Notification::expires_at_ms)
			.min();
		let wanted: Vec<(String, String, ToastKind, Option<String>)> = queue
			.raised()
			.iter()
			.take(Toasts::LIMIT)
			.map(|held| (held.key.clone(), held.title.clone(), kind(held), opened(held, opens)))
			.collect();

		let Self { toasts, shown, .. } = self;
		shown.retain(|held| {
			let current = wanted.iter().any(|(key, title, kind, open)| {
				*key == held.key
					&& *title == held.title
					&& *kind == held.kind
					&& open.is_some() == held.opens
			});
			if !current {
				toasts.update(cx, |toasts, cx| toasts.dismiss(held.id, cx));
			}
			current
		});
		for (key, title, kind, open) in wanted {
			if shown.iter().any(|held| held.key == key) {
				continue;
			}
			let opens = open.is_some();
			let mut toast = Toast::new(kind, title.clone()).lasts(None);
			if let Some(path) = open {
				let app = app.downgrade();
				toast = toast.action("Open", move |_, cx| {
					let action = HostAction::OpenExternal { path: path.clone() };
					app.update(cx, |app, cx| {
						app.dispatch(action, SurfaceId::GlobalTitlebarLine, cx);
					})
					.ok();
				});
			}
			let id = toasts.update(cx, |toasts, cx| toasts.push(toast, cx));
			shown.push(Shown { key, title, kind, opens, id });
		}

		self.expiry = match (next, self.expiry.take()) {
			(Some(at), Some((armed, task))) if armed == at => Some((armed, task)),
			(Some(at), _) => Some((at, expire_at(at, app.downgrade(), cx))),
			(None, _) => None,
		};
	}

	/// Takes the announcement drawn as toast `id` off the queue.
	fn dismissed(&mut self, id: ToastId, app: &Entity<AppState>, cx: &mut Context<Workspace>) {
		let Some(at) = self.shown.iter().position(|held| held.id == id) else {
			return;
		};
		let held = self.shown.remove(at);
		app.update(cx, |app, cx| app.dismiss_notification(&held.key, cx));
	}
}

/// Expires the queue of `app` at `at`, in milliseconds since the Unix epoch.
///
/// The task holds `app` weakly: a task idle at shutdown is dropped after the
/// entities are, and a strong handle in it would outlive them.
fn expire_at(at: u64, app: WeakEntity<AppState>, cx: &Context<Workspace>) -> Task<()> {
	let wait = Duration::from_millis(at.saturating_sub(now_ms()));
	cx.spawn(async move |_, cx| {
		cx.background_executor().timer(wait).await;
		app.update(cx, |app, cx| app.expire_notifications(at, cx))
			.ok();
	})
}

/// The tone an announcement is drawn in.
const fn kind(held: &Notification) -> ToastKind {
	match (held.source, held.priority) {
		(NotificationSource::RequestFailed | NotificationSource::DeliveryFailed, _)
		| (NotificationSource::Extension, NotificationPriority::Urgent) => ToastKind::Error,
		(NotificationSource::DecisionWaiting | NotificationSource::Extension, _) => ToastKind::Info,
		(NotificationSource::Export, _) => ToastKind::Success,
	}
}

/// The file an announcement offers to open while the host opens files: the
/// one an export wrote, which its announcement holds as its detail.
fn opened(held: &Notification, opens: bool) -> Option<String> {
	match held.source {
		NotificationSource::Export if opens => held.detail.clone(),
		NotificationSource::Export
		| NotificationSource::DecisionWaiting
		| NotificationSource::RequestFailed
		| NotificationSource::DeliveryFailed
		| NotificationSource::Extension => None,
	}
}

/// The wall clock in milliseconds since the Unix epoch, the clock the host
/// stamps announcements and the freeze of its agents with.
pub(super) fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}
