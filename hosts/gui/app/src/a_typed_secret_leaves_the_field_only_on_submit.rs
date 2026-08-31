//! WHY THIS SUITE EXISTS. The provider-auth field is the one editor in this
//! window whose contents are a credential, and its handler reads the provider
//! from the overlay stack rather than from the event it was handed. Two
//! failures there are silent, and each one moves a secret: a handler that acts
//! on every editor event ships a half-typed credential on the first keystroke,
//! and one that continues with no `ProviderAuth` overlay on the stack sends it
//! under whatever overlay is on top. Nothing on screen changes either way, so
//! the event kind and the overlay are both asserted here.
//!
//! WHAT IT DOES NOT CATCH. Where the secret goes once the store accepts it. A
//! test window's adapter is detached, so the evidence a submit reached the host
//! is the authentication command going in flight, not bytes on a socket.
//!
//! Nothing about the field itself: masking, the refusal to copy or cut, and the
//! zeroizing of the taken value belong to the kit's own field suite.

use gpui::{Entity, TestAppContext, VisualTestContext};
use veyyon_gui_core::{
	UiCommand,
	host::{HostEvent, SnapshotSection},
	model::{
		AuthFlowState, AuthState, CommandState, ProviderId, ProviderView, RemoteData, Versioned,
	},
	navigation::Overlay,
	store::CommandTarget,
};
use veyyon_gui_kit::input::EditorEvent;

use crate::{shell::Shell, the_keyboard_reaches_every_route::open};

fn provider() -> ProviderId {
	ProviderId::new("anthropic").expect("a nonempty provider id")
}

/// What a host reports while a sign-in waits for a credential. The field is
/// drawn in this phase and in no other.
fn phase(flow: Option<AuthFlowState>) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Authentication(Versioned {
		revision: 1,
		value:    AuthState {
			providers: RemoteData::Ready(vec![ProviderView {
				id:            provider(),
				name:          "Anthropic".to_owned(),
				available:     true,
				authenticated: false,
				status:        None,
				error:         None,
			}]),
			accounts: RemoteData::Empty,
			flow_provider: Some(provider()),
			flow,
		},
	}))
}

/// Reach the field the way a user reaches it: the host reports the phase, then
/// the overlay opens over it.
fn open_provider_auth(
	shell: &Entity<Shell>,
	flow: Option<AuthFlowState>,
	cx: &mut VisualTestContext,
) {
	shell.update(cx, |shell, _| {
		shell.bridge.apply(&mut shell.store, phase(flow));
	});
	let overlay = Overlay::ProviderAuth { provider: provider() };
	cx.update(|window, cx| {
		shell.update(cx, |shell, cx| shell.perform(UiCommand::OpenOverlay(overlay), window, cx));
	});
}

fn composer(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> String {
	shell.read_with(cx, |shell, cx| shell.handles.editors.composer.read(cx).text().to_owned())
}

fn secret(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> String {
	shell.read_with(cx, |shell, cx| {
		shell
			.handles
			.editors
			.provider_secret
			.read(cx)
			.text()
			.to_owned()
	})
}

fn authentication(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> CommandState {
	shell.read_with(cx, |shell, _| shell.store.command_state(&CommandTarget::Authentication))
}

#[gpui::test]
fn a_submit_takes_the_secret_out_of_the_field_and_asks_the_host(cx: &mut TestAppContext) {
	let (shell, cx) = open(cx);
	open_provider_auth(&shell, Some(AuthFlowState::AwaitingSecretInput), cx);

	cx.simulate_input("a-secret");
	assert_eq!(secret(&shell, cx), "a-secret", "the overlay's field never took the keyboard");

	cx.simulate_keystrokes("enter");
	cx.run_until_parked();

	assert_eq!(secret(&shell, cx), "", "the field kept the credential it submitted");
	let state = authentication(&shell, cx);
	assert!(matches!(state, CommandState::Pending { .. }), "the submit asked no host: {state:?}");
}

#[gpui::test]
fn a_keystroke_asks_the_host_nothing(cx: &mut TestAppContext) {
	let (shell, cx) = open(cx);
	open_provider_auth(&shell, Some(AuthFlowState::AwaitingSecretInput), cx);

	cx.simulate_input("half typed");
	cx.run_until_parked();

	assert_eq!(secret(&shell, cx), "half typed", "a keystroke emptied the field");
	assert_eq!(
		authentication(&shell, cx),
		CommandState::Idle,
		"a keystroke sent the half-typed credential"
	);
}

#[gpui::test]
fn a_submit_delivered_after_the_overlay_closed_asks_the_host_nothing(cx: &mut TestAppContext) {
	let (shell, cx) = open(cx);
	open_provider_auth(&shell, Some(AuthFlowState::AwaitingSecretInput), cx);
	cx.simulate_input("a-secret");

	cx.update(|window, cx| {
		shell.update(cx, |shell, cx| shell.perform(UiCommand::CloseTopOverlay, window, cx));
	});
	// Emitted onto the field rather than typed: with the overlay gone the field
	// is not drawn, and this is the shape of a submit that was already in flight
	// when the stack moved on.
	shell.update(cx, |shell, cx| {
		shell
			.handles
			.editors
			.provider_secret
			.update(cx, |_, cx| cx.emit(EditorEvent::Submit));
	});
	cx.run_until_parked();

	assert_eq!(secret(&shell, cx), "a-secret", "a submit with no provider took the secret");
	assert_eq!(
		authentication(&shell, cx),
		CommandState::Idle,
		"a submit with no provider overlay still asked the host"
	);
}

#[gpui::test]
fn an_overlay_phase_that_draws_no_field_leaves_the_keyboard_where_it_was(cx: &mut TestAppContext) {
	// The credential field is the only thing this overlay draws that takes a
	// keystroke, and it is drawn in one phase. Focusing it in any other phase
	// puts the keyboard on an element that is not in the tree, and a binding
	// dispatching from there reaches nothing at all: the window goes deaf until
	// the overlay closes.
	let (shell, cx) = open(cx);
	cx.simulate_input("a draft");

	open_provider_auth(&shell, None, cx);
	cx.simulate_input("!");

	assert_eq!(secret(&shell, cx), "", "a field the phase does not draw took the keyboard");
	assert_eq!(composer(&shell, cx), "a draft!", "the window went deaf behind the overlay");
}
