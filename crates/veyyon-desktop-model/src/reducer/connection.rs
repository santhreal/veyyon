use crate::{
	connection::ConnectionState,
	damage::{Damage, DamageSet},
	store::Store,
};

/// Reduces a connection state change event into store updates and header
/// damage.
pub fn reduce_connection(store: &mut Store, state: ConnectionState) -> DamageSet {
	store.connection = state;
	let mut damage = DamageSet::new();
	damage.insert(Damage::ConnectionLine);
	damage.insert(Damage::Titlebar);
	damage
}
