//! The entry tree a session's tree sheet draws.

use crate::{
	connection::SessionId,
	damage::{Damage, DamageSet},
	domain::SessionTreeView,
	store::Store,
};

/// The tree sheet takes the transcript's place in the session's thread, so a
/// new tree repaints that session's transcript slot and nothing else.
pub(super) fn reduce_tree(
	store: &mut Store,
	session: SessionId,
	tree: SessionTreeView,
	damage: &mut DamageSet,
) {
	store.domains.session_trees.insert(session.clone(), tree);
	damage.insert(Damage::TranscriptFull(session));
}
