use crate::{
	connection::RequestId,
	damage::{Damage, DamageSet},
	error::BackendError,
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
pub fn reduce_request_failed(
	store: &mut Store,
	request: RequestId,
	_error: BackendError,
) -> DamageSet {
	store.retries.fail(request);
	let mut damage = DamageSet::new();
	damage.insert(Damage::ConnectionLine);
	damage
}
