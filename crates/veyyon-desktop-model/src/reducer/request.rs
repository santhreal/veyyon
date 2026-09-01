use crate::{
	connection::RequestId,
	damage::{Damage, DamageSet},
	error::BackendError,
	store::Store,
};

/// Reduces a request success notification.
pub const fn reduce_request_succeeded(_store: &mut Store, _request: RequestId) -> DamageSet {
	DamageSet::new()
}

/// Reduces a request failure notification, invalidating the connection status
/// line.
pub fn reduce_request_failed(
	_store: &mut Store,
	_request: RequestId,
	_error: BackendError,
) -> DamageSet {
	let mut damage = DamageSet::new();
	damage.insert(Damage::ConnectionLine);
	damage
}
