//! WHY: an account is connected from the Authentication destination, and that
//! page is a state machine — the host reports where the flow stands and the
//! page draws the one step that moves it on. A state whose step is not drawn,
//! or is drawn and wired to another state's step, strands the account: the
//! operator presses the only control on the page and the flow neither advances
//! nor ends. Nothing else recovers it, because the flow belongs to the host and
//! this destination is the only surface that answers it.
//!
//! CLASS CLOSED: every `AuthFlowState` the host can report, pressed at the
//! pixels the frame drew rather than dispatched by hand. The states are
//! enumerated by a match with no wildcard arm, so a sixth state fails to
//! compile here until its step is written down, and the controls are found by
//! reading the frame's own hit rects inside the sheet the palette tokens size,
//! so a step that moves or is drawn outside its hitbox is caught too. Held
//! shut against:
//!
//! 1. A state that draws no step, or draws a control that answers nothing.
//! 2. A step wired to another state's intent — a cancel that retries, a retry
//!    that opens a browser, a dismiss that submits.
//! 3. A completed flow that still offers a step, so a connected account could
//!    be cancelled or restarted from a page stating it is connected.
//! 4. A browser step that opens some URL other than the one the host issued.
//! 5. A submit that sends a secret the operator never typed, which is the
//!    defect `a-field-sends-what-the-operator-typed-into-it` closed over the
//!    field itself and this suite holds over the drawn button.
//!
//! NOT CAUGHT: what the host does with the step, which is its own suite; the
//! empty-secret refusal and the return-key commit, which
//! `a-field-sends-what-the-operator-typed-into-it` owns; and the keyboard route
//! onto these controls, which the destination focus suites own.

#[path = "support/queue-scroll/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared session helpers")]
mod queue_scroll;
#[path = "support/settings_seed.rs"]
mod settings_seed;

use queue_scroll::open_session;
use settings_seed::seed_state_for_page;
use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_model::{AuthFlowState, AuthFlowView};
use veyyon_desktop_scene::{Captured, headless_context};
use veyyon_desktop_surface::{
	Intent, Overlay, SettingsPage, ShellState, fixture, navigation::SurfaceRoute,
};
use veyyon_gpui::{Bounds, Pixels, Point};

/// The window this renders in: wide enough that the sheet takes the width the
/// palette tokens author rather than the width the viewport leaves.
const WINDOW_W: u32 = 1440;
const WINDOW_H: u32 = 900;

/// The provider under authentication. Every intent a step dispatches names it,
/// so a step wired to a provider of its own fails here.
const PROVIDER: &str = "anthropic";
/// The URL the host issued for the browser step.
const URL: &str = "https://provider.example/authorize?code=neutral";
/// The secret typed into the field before the submit is pressed.
const SECRET: &str = "sk-not-a-real-key";

/// The steps a state offers, as the intents pressing them must produce.
///
/// A match with no wildcard arm: a state added to `AuthFlowState` stops this
/// compiling until this suite states which step answers it.
fn steps_of(state: AuthFlowState) -> Vec<Intent> {
	match state {
		// The authorization happens in a browser, so the page hands over the
		// URL the host issued and offers the way out of a flow that never
		// comes back.
		AuthFlowState::AwaitingBrowser => {
			vec![Intent::OpenAuthUrl(URL.to_owned()), Intent::CancelAuthFlow]
		},
		// The secret is typed on the page, and the submit carries what the
		// field holds rather than what the render was built from.
		AuthFlowState::AwaitingSecret => vec![
			Intent::SubmitAuthSecret { provider: PROVIDER.to_owned(), secret: SECRET.to_owned() },
			Intent::CancelAuthFlow,
		],
		// A failure is answered twice: try again, or stop.
		AuthFlowState::Failed => vec![Intent::RetryAuthFlow, Intent::CancelAuthFlow],
		// A cancelled flow can only be started again.
		AuthFlowState::Cancelled => vec![Intent::RetryAuthFlow],
		// A connected account has no step. The row states the account and
		// offers nothing to press.
		AuthFlowState::Completed => Vec::new(),
	}
}

/// The flow as the host reports it, with every optional line filled: a page
/// that reads the wrong one still draws a row, so leaving them empty would
/// hide a step wired to the wrong text.
fn flow(state: AuthFlowState) -> AuthFlowView {
	AuthFlowView {
		provider: PROVIDER.to_owned(),
		state,
		url: Some(URL.to_owned()),
		prompt: Some("Complete the authorization".to_owned()),
		message: Some("The provider answered".to_owned()),
	}
}

/// The Authentication destination, open on the flow the host reported and
/// routed the way the command palette routes to it.
fn destination(state: AuthFlowState) -> ShellState {
	let mut settings = seed_state_for_page(SettingsPage::Authentication);
	settings.auth_flow = Some(flow(state));
	settings.route = Some(SurfaceRoute::Page(SettingsPage::Authentication));
	let mut shell = fixture::populated();
	shell.overlay = Some(Overlay::Settings(Box::new(settings)));
	shell
}

/// Whether `outer` holds `inner`, to half a pixel.
fn contains(outer: Bounds<Pixels>, inner: Bounds<Pixels>) -> bool {
	let (ol, ot) = (f32::from(outer.origin.x), f32::from(outer.origin.y));
	let (or, ob) = (ol + f32::from(outer.size.width), ot + f32::from(outer.size.height));
	let (il, it) = (f32::from(inner.origin.x), f32::from(inner.origin.y));
	let (ir, ib) = (il + f32::from(inner.size.width), it + f32::from(inner.size.height));
	il >= ol - 0.5 && ir <= or + 0.5 && it >= ot - 0.5 && ib <= ob + 0.5
}

/// The sheet the destination draws in: the tallest hit rect as wide as the
/// palette geometry sizes an overlay (§5.8).
///
/// Taken from the tokens rather than from a constant here, and taken from the
/// frame rather than computed, so a sheet that moved or resized is followed
/// instead of missed. Everything pressed below is inside it, which keeps the
/// press off the modal scrim — a click there dismisses the destination, and
/// every later press would land on whatever the shell draws instead.
fn sheet(frame: &Captured, width_px: f32) -> Bounds<Pixels> {
	frame
		.hitboxes
		.iter()
		.filter(|rect| (f32::from(rect.size.width) - width_px).abs() < 1.0)
		.max_by(|a, b| {
			f32::from(a.size.height)
				.partial_cmp(&f32::from(b.size.height))
				.unwrap_or(std::cmp::Ordering::Equal)
		})
		.copied()
		.unwrap_or_else(|| panic!("the destination draws a sheet {width_px}px wide"))
}

/// Every control the sheet holds: a hit rect inside it that holds no other, so
/// a band around two buttons counts as neither.
///
/// The shell keeps drawing behind the sheet, and the sheet's rect covers part
/// of it, so `behind` is the set the same shell registers with no destination
/// open: subtracting it leaves the controls the destination itself drew.
fn controls(
	frame: &Captured,
	sheet: Bounds<Pixels>,
	behind: &[Bounds<Pixels>],
) -> Vec<Bounds<Pixels>> {
	let within: Vec<Bounds<Pixels>> = frame
		.hitboxes
		.iter()
		.copied()
		.filter(|rect| *rect != sheet && contains(sheet, *rect) && !behind.contains(rect))
		.collect();
	let mut leaves: Vec<Bounds<Pixels>> = Vec::new();
	for rect in &within {
		let holds_another = within
			.iter()
			.any(|other| other != rect && contains(*rect, *other));
		if !holds_another && !leaves.contains(rect) {
			leaves.push(*rect);
		}
	}
	leaves.sort_by(|a, b| {
		let key = |rect: &Bounds<Pixels>| (f32::from(rect.origin.y), f32::from(rect.origin.x));
		key(a)
			.partial_cmp(&key(b))
			.unwrap_or(std::cmp::Ordering::Equal)
	});
	leaves
}

fn centre(rect: Bounds<Pixels>) -> Point<Pixels> {
	Point { x: rect.origin.x + rect.size.width / 2.0, y: rect.origin.y + rect.size.height / 2.0 }
}

/// The intents in a stable order, so two lists compare regardless of which
/// control the sweep happened to press first.
fn named(intents: &[Intent]) -> Vec<String> {
	let mut names: Vec<String> = intents.iter().map(|intent| format!("{intent:?}")).collect();
	names.sort();
	names
}

#[test]
fn every_authentication_state_draws_the_step_it_is_waiting_on_and_no_other() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let sheet_px = tokens.surface.palette.width_px;
	assert!(
		sheet_px < WINDOW_W as f32,
		"the sheet takes its authored width at {WINDOW_W}px rather than the viewport's"
	);

	// One press per session: a step lands locally as well as reaching the
	// host — a cancel detaches the transport, which draws the attach dialog
	// over this page — so a second press in the same window would be aimed at
	// a surface the first one replaced.
	let behind = {
		let mut cx = headless_context().expect("a headless renderer is required");
		let mut session = open_session(&mut cx, fixture::populated(), WINDOW_W, WINDOW_H);
		session
			.frame()
			.expect("the shell renders with no destination open")
			.hitboxes
	};

	for state in [
		AuthFlowState::AwaitingBrowser,
		AuthFlowState::AwaitingSecret,
		AuthFlowState::Failed,
		AuthFlowState::Cancelled,
		AuthFlowState::Completed,
	] {
		let count = {
			let mut cx = headless_context().expect("a headless renderer is required");
			let mut session = open_session(&mut cx, destination(state), WINDOW_W, WINDOW_H);
			let frame = session.frame().expect("the destination renders");
			let drawn = controls(&frame, sheet(&frame, sheet_px), &behind);
			assert!(
				!drawn.is_empty(),
				"the {state:?} page draws controls of its own inside its sheet"
			);
			drawn.len()
		};

		let mut dispatched: Vec<Intent> = Vec::new();
		for index in 0..count {
			let mut cx = headless_context().expect("a headless renderer is required");
			let mut session = open_session(&mut cx, destination(state), WINDOW_W, WINDOW_H);
			let frame = session.frame().expect("the destination renders");
			let drawn = controls(&frame, sheet(&frame, sheet_px), &behind);
			assert_eq!(
				drawn.len(),
				count,
				"the {state:?} page draws the same controls on every frame of it"
			);
			if state == AuthFlowState::AwaitingSecret {
				// Typed rather than seeded: the field the frame drew is the
				// retained editor the submit reads, and the focus it took on
				// the first frame is the only route a keystroke has into it.
				session
					.type_text(SECRET)
					.expect("the secret field takes the typing");
			}
			session
				.click(centre(drawn[index]))
				.expect("the control answers a press");
			dispatched.extend(
				session
					.update(|view, _window, _cx| view.drain_intents())
					.expect("what the press dispatched is read back"),
			);
		}

		assert_eq!(
			named(&dispatched),
			named(&steps_of(state)),
			"the controls the {state:?} page draws answer with exactly its own steps"
		);
	}
}
