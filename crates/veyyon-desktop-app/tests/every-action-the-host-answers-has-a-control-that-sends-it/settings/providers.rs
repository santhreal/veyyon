//! The Providers page: each provider's sign-in, the sign-in running now and
//! the stored accounts.

use serde_json::json;
use veyyon_desktop_model::{HostEvent, SnapshotSectionKind};

use super::{open, press, seed, type_into};
use crate::harness::{Win, section};

/// A sign-in of `anthropic` in `state`, with no page to open.
fn flow(w: &mut Win<'_>, state: &str) {
	let flow = section(json!({ "AuthFlow": {
		"provider": "anthropic", "state": state, "url": null, "prompt": null, "message": null,
	} }));
	w.apply(vec![HostEvent::Snapshot(flow)]);
}

pub fn logout_row(w: &mut Win<'_>) {
	w.palette("/logout");
}

/// Sign in on `openai`, which the corpus reports signed out.
pub fn sign_in(w: &mut Win<'_>) {
	seed(w, &[SnapshotSectionKind::Providers]);
	open(w, "providers");
	press(w, "sign-in-openai");
}

pub fn paste_code(w: &mut Win<'_>) {
	flow(w, "AwaitingSecret");
	open(w, "providers");
	type_into(w, "auth-secret", "code-1234");
	w.keys("enter");
}

/// The corpus sign-in, which waits on the browser at a page to open.
pub fn open_sign_in_page(w: &mut Win<'_>) {
	seed(w, &[SnapshotSectionKind::AuthFlow]);
	open(w, "providers");
	press(w, "auth-open-url");
}

pub fn cancel(w: &mut Win<'_>) {
	seed(w, &[SnapshotSectionKind::AuthFlow]);
	open(w, "providers");
	press(w, "auth-cancel");
}

pub fn retry(w: &mut Win<'_>) {
	flow(w, "Failed");
	open(w, "providers");
	press(w, "auth-retry");
}

/// Sign out of the corpus's stored `anthropic` login, then Enter on the
/// question it asks.
pub fn sign_out(w: &mut Win<'_>) {
	seed(w, &[SnapshotSectionKind::Providers, SnapshotSectionKind::Accounts]);
	open(w, "providers");
	press(w, "sign-out-anthropic-3");
	w.keys("enter");
}
