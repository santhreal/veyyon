//! WHY THIS SUITE EXISTS:
//! Every text field on the desktop was drawn from a value rather than from an
//! editor, so nothing an operator typed reached the action beside it. The
//! attach dialog drew a field whose content was the literal string
//! `"secret-key-field"`, and its Submit sent `secret: String::new()`, which
//! the host answered with `INVALID_ARGUMENTS`: authenticating from the desktop
//! was impossible by construction. The Accounts page drew the same field and
//! wrote keystrokes into a mutex allocated inside the render, through a
//! callback the primitive never invoked.
//!
//! THE CLASS THIS CLOSES:
//! A control drawn as an input that carries no input to the action it
//! triggers, on the two surfaces that ask for a secret. Two halves hold it
//! shut. `TextField::new` and `TextArea::new` take `Entity<Editor>` rather
//! than a value, so a field built from a string no longer compiles anywhere
//! in the workspace, and this suite drives the remaining question — that what
//! was typed is what the action sends — through a real window, the focus the
//! frame hands out, and the commit both the button and the return key reach.
//! The settings rows are the sibling half of the same defect and are covered
//! by `a-setting-row-sends-the-value-its-field-holds`.
//!
//! WHAT IT DOES NOT CATCH:
//! It reaches Submit through the listener body the button installs rather than
//! through a click at the button's pixels, so a button drawn outside its own
//! hitbox is not covered here; `every-registered-scene-builds-and-renders`
//! covers geometry. Masking and the clipboard refusal are asserted over the
//! editor in `a-masked-field-draws-nothing-of-what-it-holds`, which this
//! suite does not repeat.

mod support;

use support::fields::{
	PROVIDER, TYPED_SECRET, accounts_page_asks_for_a_secret, driven, transport_asks_for_a_secret,
	typed_then_submitted,
};
use veyyon_desktop_surface::Intent;

/// The one intent both surfaces raise when a secret is submitted.
fn submitted(secret: &str) -> Vec<Intent> {
	vec![Intent::SubmitAuthSecret { provider: PROVIDER.to_owned(), secret: secret.to_owned() }]
}

#[test]
fn the_secret_the_operator_typed_is_what_the_attach_dialog_sends() {
	assert_eq!(
		typed_then_submitted(transport_asks_for_a_secret(), TYPED_SECRET),
		submitted(TYPED_SECRET),
		"the dialog sends the secret typed into its field, to the provider that asked"
	);
}

#[test]
fn the_secret_the_operator_typed_is_what_the_accounts_page_sends() {
	assert_eq!(
		typed_then_submitted(accounts_page_asks_for_a_secret(), TYPED_SECRET),
		submitted(TYPED_SECRET),
		"the Accounts page sends what its field holds, not an empty secret"
	);
}

#[test]
fn the_return_key_sends_the_secret_without_reaching_for_the_button() {
	let raised = driven(transport_asks_for_a_secret(), |session| {
		session
			.type_text(TYPED_SECRET)
			.expect("typing reaches the focused field");
		session
			.keystroke("enter")
			.expect("the field takes a return");
		session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("the view is read after the return")
	});
	assert_eq!(raised, submitted(TYPED_SECRET), "a return in the secret field submits it");
}

#[test]
fn an_empty_secret_is_refused_where_it_was_asked_for_rather_than_sent() {
	let (raised, notice) = driven(transport_asks_for_a_secret(), |session| {
		session
			.update(|view, _window, cx| {
				view.submit_pending_secret(cx);
				(view.drain_intents(), view.notice().map(str::to_owned))
			})
			.expect("the submit runs against the live view")
	});
	assert!(raised.is_empty(), "an empty field sends nothing to the host: {raised:?}");
	let notice = notice.expect("the refusal is stated in the window");
	assert!(
		notice.contains("secret"),
		"the refusal names what is missing rather than failing silently: {notice}"
	);
}

#[test]
fn a_secret_typed_after_a_refusal_withdraws_it_and_sends() {
	let (raised, notice) = driven(transport_asks_for_a_secret(), |session| {
		session
			.update(|view, _window, cx| {
				view.submit_pending_secret(cx);
				view.drain_intents()
			})
			.expect("the empty submit is refused");
		session
			.type_text(TYPED_SECRET)
			.expect("typing reaches the focused field");
		session
			.update(|view, _window, cx| {
				view.submit_pending_secret(cx);
				(view.drain_intents(), view.notice().map(str::to_owned))
			})
			.expect("the second submit runs against the live view")
	});
	assert_eq!(raised, submitted(TYPED_SECRET), "the field kept the keystrokes across the refusal");
	assert_eq!(notice, None, "the refusal is withdrawn once the field carries a value");
}
