//! WHY THIS TEST EXISTS:
//! Connection disruptions and authentication barriers are gating states that
//! block operator work until answered. If an attach or authentication screen
//! renders a blank frame, lacks an actionable control, or shares identical
//! rendered pixels with an unrelated phase, the operator is stranded without
//! recourse.
//!
//! THE CLASS THIS CLOSES:
//! Unregistered or visually indistinguishable connection and authentication
//! states, and screens that fail to expose their designated recovery or
//! authorization action.
//!
//! WHAT IT DOES NOT CATCH:
//! It does not validate remote socket network timeouts or external OAuth server
//! endpoints; it asserts the deterministic local surface presentation and
//! action availability.

use std::{
	collections::BTreeMap,
	hash::{DefaultHasher, Hash, Hasher},
	path::Path,
};

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	Appearance, Captured, RenderOptions, SceneRegistry, distinct_pixel_values, headless_context,
	render_view_captured,
};
use veyyon_desktop_surface::{ConnectionPhase, ShellState, ShellView, tokens::install_tokens};
use veyyon_gpui::{App, AppContext, Window};

/// One value of every phase, the waiting screens first so they set the
/// hit-rect floor before an actionable screen is measured against it. The
/// `match` in [`expects_an_action`] is exhaustive, so a phase added to the
/// enum and not to this list fails to compile before it can be missing from
/// the catalogue.
fn every_phase() -> Vec<ConnectionPhase> {
	vec![
		ConnectionPhase::Connecting { attempt: 2 },
		ConnectionPhase::Syncing { received: 3, expected: Some(10) },
		ConnectionPhase::Detached,
		ConnectionPhase::Attached,
		ConnectionPhase::Reconnecting {
			attempt:     1,
			retry_at_ms: 5000,
			message:     "Connection reset by peer".to_string(),
		},
		ConnectionPhase::Fatal { message: "Protocol version mismatch".to_string() },
		ConnectionPhase::NeedsSecret { provider: "anthropic".to_string() },
		ConnectionPhase::AwaitingExternalUrl {
			provider: "openai".to_string(),
			url:      "https://auth.example.test/oauth".to_string(),
		},
	]
}

/// Whether the phase's screen owes the operator a control: a retry, a
/// submit, an open-in-browser. Connecting and syncing are waits with nothing
/// to press, and the attached shell is the product itself.
const fn expects_an_action(phase: &ConnectionPhase) -> bool {
	match phase {
		ConnectionPhase::Detached
		| ConnectionPhase::Reconnecting { .. }
		| ConnectionPhase::Fatal { .. }
		| ConnectionPhase::NeedsSecret { .. }
		| ConnectionPhase::AwaitingExternalUrl { .. } => true,
		ConnectionPhase::Connecting { .. }
		| ConnectionPhase::Syncing { .. }
		| ConnectionPhase::Attached => false,
	}
}

fn render_phase(phase: ConnectionPhase) -> Captured {
	let mut cx = headless_context().expect("headless context");
	let tokens = load_bundled_tokens().expect("bundled tokens");
	let theme = load_bundled_theme("dark").expect("bundled dark theme");
	let options = RenderOptions {
		width: 800,
		height: 600,
		appearance: Appearance::Dark,
		scale_factor: 1.0,
		..RenderOptions::default()
	};
	render_view_captured(&mut cx, &options, move |_window: &mut Window, app: &mut App| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("tokens install");
		let state = ShellState { connection: phase, ..ShellState::default() };
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("the shell renders every connection phase")
}

fn fingerprint(bytes: &[u8]) -> u64 {
	let mut hasher = DefaultHasher::new();
	bytes.hash(&mut hasher);
	hasher.finish()
}

#[test]
fn every_connection_and_auth_phase_is_a_registered_scene() {
	let registry = SceneRegistry::new();
	for phase in every_phase() {
		let name = format!("shell/{}", phase.scene_slug());
		assert!(registry.get(&name).is_some(), "{phase:?} has no scene registered as {name}");
	}
}

#[test]
fn every_connection_and_auth_phase_renders_a_distinct_frame_with_its_action() {
	let mut frames: BTreeMap<u64, ConnectionPhase> = BTreeMap::new();
	let mut hitboxes_without_an_action: Option<usize> = None;

	for phase in every_phase() {
		let captured = render_phase(phase.clone());
		let frame = &captured.frame;
		assert_eq!((frame.width(), frame.height()), (800, 600), "{phase:?} frame size");

		let distinct = distinct_pixel_values(frame);
		assert!(distinct > 2, "{phase:?} drew {distinct} distinct pixel values: a blank screen");

		if let Some(earlier) = frames.insert(fingerprint(frame.as_bytes()), phase.clone()) {
			panic!("{phase:?} renders the same bytes as {earlier:?}");
		}
		if let ConnectionPhase::Connecting { .. } = &phase {
			hitboxes_without_an_action = Some(captured.hitboxes.len());
		}
		if expects_an_action(&phase) {
			let floor = hitboxes_without_an_action
				.expect("Connecting renders before every actionable phase in every_phase()");
			assert!(
				captured.hitboxes.len() > floor,
				"{phase:?} registers {} hit rects, no more than the {floor} of a waiting screen, so \
				 its action is not clickable",
				captured.hitboxes.len()
			);
		}
	}
}
