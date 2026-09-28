//! The sections an extension's calls on its UI surface reach the window as.
//!
//! The chrome replaces its entry and repaints the band that draws it. An edit
//! queues behind the edits the composer has not taken yet, completions keep
//! the answer to the newest query, and a notice goes on the announcement
//! stack.

use crate::{
	Notification, NotificationPriority, NotificationSource,
	connection::SessionId,
	damage::{Damage, DamageSet},
	domain::{
		ComposerCompletionsView, ComposerEditView, ExtensionNoticeLevel, ExtensionNoticeView,
		ExtensionUiView, queue_composer_edit,
	},
	store::Store,
};

/// Statuses and the working message are drawn in the run bar, and widgets
/// above and below the composer, so both bands repaint.
pub(super) fn reduce_extension_ui(
	store: &mut Store,
	session: SessionId,
	ui: ExtensionUiView,
	damage: &mut DamageSet,
) {
	if ui == ExtensionUiView::default() {
		store.domains.extension_ui.remove(&session);
	} else {
		store.domains.extension_ui.insert(session.clone(), ui);
	}
	damage.insert(Damage::RunBar(session.clone()));
	damage.insert(Damage::Composer(session));
}

/// An edit waits for the session's composer to take it, which it does when
/// the session is shown.
pub(super) fn reduce_composer_edit(
	store: &mut Store,
	session: SessionId,
	edit: ComposerEditView,
	damage: &mut DamageSet,
) {
	queue_composer_edit(
		store
			.domains
			.composer_edits
			.entry(session.clone())
			.or_default(),
		edit,
	);
	damage.insert(Damage::Composer(session));
}

/// Completions answer the composer's newest query; an answer to an earlier
/// one that arrives after it is dropped.
pub(super) fn reduce_composer_completions(
	store: &mut Store,
	session: SessionId,
	completions: ComposerCompletionsView,
	damage: &mut DamageSet,
) {
	if store
		.domains
		.completions
		.get(&session)
		.is_some_and(|held| held.query > completions.query)
	{
		return;
	}
	store
		.domains
		.completions
		.insert(session.clone(), completions);
	damage.insert(Damage::Composer(session));
}

/// A notice is announced whichever session is open, the way the terminal
/// states it whatever the operator is doing. One key per session and message,
/// so an extension repeating itself raises one card.
pub(super) fn reduce_extension_notice(
	store: &mut Store,
	session: &SessionId,
	notice: ExtensionNoticeView,
	damage: &mut DamageSet,
) {
	let (priority, detail) = match notice.level {
		ExtensionNoticeLevel::Info => (NotificationPriority::Low, "Extension notice"),
		ExtensionNoticeLevel::Warning => (NotificationPriority::Normal, "Extension warning"),
		ExtensionNoticeLevel::Error => (NotificationPriority::Urgent, "Extension error"),
	};
	store.notifications.raise(Notification {
		key: format!("{}:{}:{}", NotificationSource::Extension.as_str(), session.0, notice.message),
		source: NotificationSource::Extension,
		priority,
		title: notice.message,
		detail: Some(detail.to_owned()),
		raised_at_ms: notice.raised_at_ms,
	});
	damage.insert(Damage::Notifications);
}
