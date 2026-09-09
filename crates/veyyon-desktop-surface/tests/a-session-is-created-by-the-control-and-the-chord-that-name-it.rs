//! WHY: creating a session is the first thing an operator does with the
//! window and the only way into an empty one, and it is reachable two ways
//! that share no code: the rail header's control, which is an
//! `IconButton` whose listener is attached only while its gate allows it, and
//! the `NewSession` chord, which travels the keymap into the shell's action
//! handler. Nothing else on the frame reports that a press did anything — the
//! new session arrives from the host — so a control whose listener was dropped
//! with the gate, or a chord bound to a command no handler answers, is a
//! button that swallows the press in silence.
//!
//! CLASS CLOSED: the header control and the chord, each driven the way an
//! operator drives it, across every `Availability` the projection can report.
//! The arms are swept from an exhaustive match, so a fifth availability fails
//! to compile until it records whether a press gets through. Held shut
//! against:
//!
//! 1. A control drawn with no listener while its gate allows it, so the press
//!    reaches nothing.
//! 2. A control that answers a press while its gate refuses it, which is the
//!    capability gate leaking (§4.3).
//! 3. A press that sends something other than a new session, or sends it more
//!    than once.
//! 4. A chord bound to `NewSession` that reaches no handler, and one that sends
//!    a different intent than the control does.
//!
//! NOT CAUGHT: what the host makes of the request, which
//! `every-action-the-host-answers-has-a-control-that-sends-it` owns; and
//! whether the created session is then opened, which is the header the host
//! sends back and belongs to
//! `a-session-the-host-stopped-listing-is-not-still-the-one-in-hand.rs` and
//! the reducer suites.

#[path = "support/model-picker/mod.rs"]
#[allow(dead_code, reason = "this binary uses the window helper and the centre of a rect")]
mod model_picker;

use model_picker::{centre, window};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_scene::session::HeadlessSession;
use veyyon_desktop_surface::{
	Availability, Intent, ShellState, ShellView, fixture,
	keymap::{Command, Keymap, resolve_chord},
};
use veyyon_gpui::{Bounds, Pixels};

/// Whether a press on a control in this state reaches its listener.
///
/// An exhaustive match with no wildcard arm: a fifth availability stops this
/// compiling until a press through it has a recorded answer (§4.3).
const fn press_gets_through(av: &Availability) -> bool {
	match av {
		Availability::Enabled | Availability::Unknown => true,
		Availability::Pending | Availability::Unavailable { .. } => false,
	}
}

/// Every availability the projection reports for a control.
fn every_availability() -> Vec<Availability> {
	vec![
		Availability::Enabled,
		Availability::Unknown,
		Availability::Pending,
		Availability::Unavailable { reason: "the host serves no sessions".to_owned() },
	]
}

/// The shell with the rail drawn and the new-session control at `av`.
fn shell(av: Availability) -> ShellState {
	let mut state = fixture::populated();
	state
		.controls
		.set_availability(SurfaceId::NewSessionButton, av);
	state
}

/// The rail header's trailing control, taken from the frame rather than
/// computed: a control drawn outside the box it registered is missed by the
/// press as surely as by the count.
///
/// The header is one band at the top of the rail holding the search area and,
/// at its trailing edge, the new-session control. Its bounds are derived from
/// the frame and the queue's own tokens: the rail is what lies within the
/// queue's width, the band is what lies above the first row the rail drew, and
/// the control is the trailing box in that band, the search area taking the
/// rest of the row from the leading edge.
fn new_session_control(session: &mut HeadlessSession<'_, ShellView>) -> Bounds<Pixels> {
	let queue = session
		.update(|view, _window, _cx| view.installed().surface.queue.clone())
		.expect("the queue's tokens are read back");
	let frame = session.frame().expect("the shell draws");
	let rail: Vec<Bounds<Pixels>> = frame
		.hitboxes
		.iter()
		.copied()
		.filter(|rect| f32::from(rect.origin.x) < queue.width_default_px)
		.collect();
	let band_bottom = rail
		.iter()
		.filter(|rect| {
			let height = f32::from(rect.size.height);
			(height - queue.card_px).abs() < 1.0 || (height - queue.line_px).abs() < 1.0
		})
		.map(|rect| f32::from(rect.origin.y))
		.fold(f32::MAX, f32::min);
	assert!(band_bottom < f32::MAX, "the rail drew no row to place its header above");
	let mut band: Vec<Bounds<Pixels>> = rail
		.into_iter()
		.filter(|rect| f32::from(rect.origin.y) + f32::from(rect.size.height) <= band_bottom)
		.collect();
	band.sort_by(|a, b| {
		f32::from(b.origin.x)
			.partial_cmp(&f32::from(a.origin.x))
			.unwrap_or(std::cmp::Ordering::Equal)
	});
	*band
		.first()
		.expect("the rail header draws a control at its trailing edge")
}

/// What the shell sent for the host after `press`, with the frame the control
/// was found on already drawn.
fn sent_after(
	av: Availability,
	press: impl FnOnce(&mut HeadlessSession<'_, ShellView>, Bounds<Pixels>),
) -> Vec<Intent> {
	window(shell(av), |session| {
		let control = new_session_control(session);
		session
			.update(|view, _window, _cx| {
				view.drain_intents();
			})
			.expect("the opening frame's intents are dropped");
		press(session, control);
		session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("what the press sent is read back")
	})
}

#[test]
fn the_rail_header_control_creates_a_session_only_while_its_gate_allows_it() {
	for av in every_availability() {
		let allowed = press_gets_through(&av);
		let sent = sent_after(av.clone(), |session, control| {
			session
				.click(centre(control))
				.expect("the press dispatches");
		});

		if allowed {
			assert_eq!(
				sent,
				vec![Intent::NewSession],
				"a press on the rail header control sent {sent:?} while it was {av:?}"
			);
		} else {
			assert!(
				sent.is_empty(),
				"a press reached the rail header control while it was {av:?}, sending {sent:?}"
			);
		}
	}
}

#[test]
fn the_new_session_chord_creates_a_session_whatever_the_control_reports() {
	// The chord is read from the keymap and resolved for this platform, so a
	// rebinding moves the press with it rather than leaving the suite driving
	// a chord nothing is bound to.
	let chord = resolve_chord(
		&Keymap::default()
			.rows()
			.into_iter()
			.find(|row| row.command == Command::NewSession)
			.map(|row| row.chord)
			.expect("the keymap binds a chord to creating a session"),
	);

	// The chord is the keyboard's own way in and carries no control gate, so
	// every availability answers it the same way.
	for av in every_availability() {
		let sent = window(shell(av.clone()), |session| {
			session.frame().expect("the shell draws");
			session
				.update(|view, _window, _cx| {
					view.drain_intents();
				})
				.expect("the opening frame's intents are dropped");
			assert!(
				session.keystroke(&chord).expect("the chord dispatches"),
				"the new-session chord reached no handler while the control was {av:?}"
			);
			session
				.update(|view, _window, _cx| view.drain_intents())
				.expect("what the chord sent is read back")
		});

		assert_eq!(
			sent,
			vec![Intent::NewSession],
			"the new-session chord sent {sent:?} while the control was {av:?}"
		);
	}
}
