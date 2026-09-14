use crate::{
	connection::RequestId,
	damage::{Damage, DamageSet},
	error::BackendError,
	notifications::{Notification, NotificationPriority, NotificationSource},
	store::Store,
};

/// Reduces a request success notification: the request the host took is one
/// nothing sends again.
pub fn reduce_request_succeeded(store: &mut Store, request: RequestId) -> DamageSet {
	store.retries.forget(request);
	DamageSet::new()
}

/// Reduces a request failure notification, invalidating the connection status
/// line and leaving the refused request on the control that sent it, which is
/// what that control's retry sends again.
///
/// The control the refusal belongs to may not be drawn -- a settings field
/// under a closed sheet, a row in a collapsed queue, a panel behind another
/// tab -- so the refusal is announced as well. The announcement is keyed by
/// the scope and code the host stated, so a provider refusing four calls in a
/// row states what happened once rather than filling the stack, while a
/// refusal from another scope is its own announcement.
pub fn reduce_request_failed(
	store: &mut Store,
	request: RequestId,
	error: BackendError,
) -> DamageSet {
	store.retries.fail(request);
	let announcement = Notification {
		key:          format!(
			"request-failed:{}:{}",
			error.scope.as_str(),
			error.code.as_deref().unwrap_or("-")
		),
		source:       NotificationSource::RequestFailed,
		priority:     NotificationPriority::Normal,
		title:        error.message,
		detail:       Some(error.scope.as_str().to_owned()),
		raised_at_ms: error.occurred_at_ms,
	};
	store.notifications.raise(announcement);
	let mut damage = DamageSet::new();
	damage.insert(Damage::ConnectionLine);
	damage.insert(Damage::Notifications);
	damage
}
