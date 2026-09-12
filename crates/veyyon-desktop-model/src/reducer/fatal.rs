use crate::{
	connection::ConnectionState,
	damage::{Damage, DamageSet},
	store::Store,
};

/// Reduces an unrecoverable protocol or framing error into fatal connection
/// state and full window damage.
pub fn reduce_fatal_protocol_error(store: &mut Store, message: String) -> DamageSet {
	store.connection = ConnectionState::Fatal { message };
	let mut damage = DamageSet::new();
	damage.insert(Damage::FullWindow);
	damage.insert(Damage::ConnectionLine);
	damage
}
