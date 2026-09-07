//! The harness the field suites drive: a real window on a seeded shell, and
//! the states a field is asked for in.
//!
//! An element is rebuilt every frame, so a suite that asks whether a field
//! carries what was typed has to open a window, draw a frame, and type into
//! whatever that frame focused. Everything here exists to do that and nothing
//! else.

use std::path::PathBuf;

use serde_json::Value;
use veyyon_desktop::{AssetPaths, StartupBundle, load_startup_bundle};
use veyyon_desktop_model::{AuthFlowState, AuthFlowView, SettingEntry, SettingKind, SettingsView};
use veyyon_desktop_scene::{Appearance, HeadlessSession, RenderOptions, headless_context};
use veyyon_desktop_surface::{
	ConnectionPhase, Intent, Overlay, SettingsPage, SettingsState, ShellState, ShellView, fixture,
	install_tokens,
};
use veyyon_gpui::{App, AppContext, Window};

/// The provider a seeded flow names, so an intent is matched against the
/// provider that asked rather than against any provider.
pub const PROVIDER: &str = "anthropic";

/// The secret the operator types. Not a real credential beyond its prefix,
/// and every assertion reads it back out of what was sent.
pub const TYPED_SECRET: &str = "sk-typed-by-the-operator";

/// The key a seeded settings row holds.
pub const SETTING_KEY: &str = "settings.seeded";

/// The bundled tokens and themes a rendered shell installs.
fn startup_assets() -> StartupBundle {
	let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../veyyon-desktop-tokens");
	load_startup_bundle(AssetPaths {
		tokens_dir: root.join("tokens"),
		themes_dir: root.join("themes"),
	})
	.expect("bundled tokens and themes load")
}

fn options() -> RenderOptions {
	RenderOptions {
		width: 1200,
		height: 800,
		appearance: Appearance::Dark,
		scale_factor: 1.0,
		..RenderOptions::default()
	}
}

/// A shell whose transport is waiting on a provider secret.
pub fn transport_asks_for_a_secret() -> ShellState {
	ShellState {
		connection: ConnectionPhase::NeedsSecret { provider: PROVIDER.to_owned() },
		..fixture::populated()
	}
}

/// A shell whose Accounts page is waiting on a provider secret.
pub fn accounts_page_asks_for_a_secret() -> ShellState {
	let mut settings = SettingsState::new(SettingsPage::Authentication);
	settings.auth_flow = Some(AuthFlowView {
		provider: PROVIDER.to_owned(),
		state:    AuthFlowState::AwaitingSecret,
		url:      None,
		prompt:   Some("Paste the key from the provider's console".to_owned()),
		message:  None,
	});
	ShellState {
		connection: ConnectionPhase::Attached,
		overlay: Some(Overlay::Settings(Box::new(settings))),
		..fixture::populated()
	}
}

/// One setting of `kind` holding `value`, with no declared choices, so a kind
/// whose control depends on its choices takes its free-form control.
fn entry(kind: SettingKind, value: Value) -> SettingEntry {
	SettingEntry {
		default: value.clone(),
		value,
		source: "default".to_owned(),
		kind,
		label: Some("Seeded".to_owned()),
		description: None,
		tab: None,
		group: None,
		values: Vec::new(),
		options: Vec::new(),
		min: None,
		max: None,
		global: false,
		advanced: false,
		hidden: false,
	}
}

/// A shell whose General page holds [`SETTING_KEY`] of `kind`.
pub fn general_page_holds(kind: SettingKind, value: Value) -> ShellState {
	let mut settings = SettingsView::new();
	settings.insert(SETTING_KEY.to_owned(), entry(kind, value));
	ShellState {
		connection: ConnectionPhase::Attached,
		overlay: Some(Overlay::Settings(Box::new(SettingsState::general(settings)))),
		..fixture::populated()
	}
}

/// Opens a window on `state`, draws one frame so input handlers and focus are
/// registered, then runs `drive` against the live view.
pub fn driven<R>(
	state: ShellState,
	drive: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R,
) -> R {
	let mut cx = headless_context().expect("a headless renderer is required to open the window");
	let bundle = startup_assets();
	let options = options();
	let mut session =
		HeadlessSession::open(&mut cx, &options, |_window: &mut Window, app: &mut App| {
			let installed = install_tokens(app, &bundle.tokens, &bundle.theme, &bundle.surface_path)
				.expect("tokens install");
			app.new(move |_cx| ShellView::new(installed, state))
		})
		.expect("the shell opens a window");
	session.frame().expect("the shell draws its first frame");
	drive(&mut session)
}

/// Types `text` into whatever the frame focused, then submits the secret the
/// way the dialog's Submit button does, and reports what the view raised.
pub fn typed_then_submitted(state: ShellState, text: &str) -> Vec<Intent> {
	driven(state, |session| {
		session
			.type_text(text)
			.expect("typing reaches the focused field");
		session
			.update(|view, _window, cx| {
				view.submit_pending_secret(cx);
				view.drain_intents()
			})
			.expect("the submit runs against the live view")
	})
}
