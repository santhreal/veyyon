//! The status-line sections a session's window receives beyond its transcript.
//!
//! Each section replaces its own domain entry and repaints the one band that
//! draws it, so a reply's rate moving every quarter second never repaints the
//! header, and a quota refresh never repaints the composer.

use crate::{
	connection::SessionId,
	damage::{Damage, DamageSet},
	domain::{CheckoutView, HostView, PaceView, QuotaView, ServingAccountView},
	store::Store,
};

/// The machine the host runs on is drawn in the thread header.
pub(super) fn reduce_host(store: &mut Store, view: HostView, damage: &mut DamageSet) {
	store.domains.host = Some(view);
	damage.insert(Damage::Titlebar);
}

/// The branch and its pull request are drawn in the thread header beside the
/// project, and the header shows the active session only: another session's
/// checkout moving is held for when it is opened and repaints nothing now.
pub(super) fn reduce_checkout(
	store: &mut Store,
	session: SessionId,
	checkout: Option<CheckoutView>,
	damage: &mut DamageSet,
) {
	let active = store.persisted.shell.active_session.as_ref() == Some(&session);
	match checkout {
		Some(checkout) => store.domains.checkouts.insert(session, checkout),
		None => store.domains.checkouts.remove(&session),
	};
	if active {
		damage.insert(Damage::Titlebar);
	}
}

/// The time spent and the reply's rate are drawn in the session's run bar.
pub(super) fn reduce_pace(
	store: &mut Store,
	session: SessionId,
	pace: PaceView,
	damage: &mut DamageSet,
) {
	store.domains.pace.insert(session.clone(), pace);
	damage.insert(Damage::RunBar(session));
}

/// The serving login is drawn beside the model in the session's composer
/// footer.
pub(super) fn reduce_serving_account(
	store: &mut Store,
	session: SessionId,
	account: Option<ServingAccountView>,
	damage: &mut DamageSet,
) {
	match account {
		Some(account) => store.domains.serving.insert(session.clone(), account),
		None => store.domains.serving.remove(&session),
	};
	damage.insert(Damage::Composer(session));
}

/// The quota windows are drawn in the session's Usage tab, beside the totals.
pub(super) fn reduce_quota(
	store: &mut Store,
	session: SessionId,
	quota: Option<QuotaView>,
	damage: &mut DamageSet,
) {
	match quota {
		Some(quota) => store.domains.quotas.insert(session.clone(), quota),
		None => store.domains.quotas.remove(&session),
	};
	damage.insert(Damage::RightPanelTab(session, "usage".to_string()));
}
