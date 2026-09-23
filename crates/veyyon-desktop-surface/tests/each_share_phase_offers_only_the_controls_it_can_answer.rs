//! WHY: a share card that draws a control the phase it is in cannot answer
//! sends the host an action it refuses, and the card has already stated that
//! the session is going out over a relay by the time the refusal lands.
//!
//! THE CLASS THIS CLOSES: a control offered in the wrong phase. Every variant
//! of `SharePhase` is swept from the enum itself, so an eighth phase is red
//! until it states which controls it offers:
//! - `Off` with a relay address: both starts, writable and read-only, and the
//!   join, which a link answers for.
//! - `Off` with none: no start, the `collab.relayUrl` setting named, and the
//!   join still offered, because a join link carries the relay it was minted
//!   on.
//! - `Starting`, `Stopping`, `Joining` and `Leaving`: no control at all,
//!   because the phase is already moving.
//! - `Hosting`: every link the room minted, a participant row stating who may
//!   write, and the stop.
//! - `Joined`: the leave alone, beside the room the guest view names.
//! - `Unknown`, the word a host on a newer protocol sent: no control, because
//!   the card claims nothing about a phase it does not know.
//!
//! It closes a second class beside that one: a link the host sends that the
//! card states nowhere. The link set is read off the serialized wire view at
//! run time, so a new address field left out of the card fails rather than
//! arriving unreachable.
//!
//! WHAT IT DOES NOT CATCH: whether the relay socket connects, and what the
//! host does with a guest once one joins.

use strum::IntoEnumIterator;
use veyyon_desktop_model::{
	ShareGuestView, ShareParticipantView, SharePhase, ShareRole, ShareView,
};
use veyyon_desktop_surface::share::{
	ShareState,
	hosting::link_rows,
	off::{has_relay, offers_join, offers_leave, offers_start, offers_stop},
	participants::participant_write_label,
};

fn sample_participant(id: u64, name: &str, can_write: bool, is_host: bool) -> ShareParticipantView {
	ShareParticipantView { id, name: name.to_string(), can_write, is_host }
}

fn sample_share_view(phase: SharePhase, relay_url: Option<&str>) -> ShareView {
	let state_word = phase.as_str().to_string();
	ShareView {
		state:         state_word,
		role:          match phase {
			SharePhase::Hosting => ShareRole::Hosting,
			SharePhase::Joining | SharePhase::Joined | SharePhase::Leaving => ShareRole::Guest,
			_ => ShareRole::Off,
		},
		relay_url:     relay_url.map(ToString::to_string),
		link:          (phase == SharePhase::Hosting)
			.then(|| "https://relay.example.com/r1".to_string()),
		web_link:      (phase == SharePhase::Hosting)
			.then(|| "https://relay.example.com/web/r1".to_string()),
		view_link:     (phase == SharePhase::Hosting)
			.then(|| "https://relay.example.com/r1?ro=1".to_string()),
		web_view_link: (phase == SharePhase::Hosting)
			.then(|| "https://relay.example.com/web/r1?ro=1".to_string()),
		participants:  if phase == SharePhase::Hosting {
			vec![
				sample_participant(0, "HostNode", true, true),
				sample_participant(1, "GuestWriter", true, false),
				sample_participant(2, "GuestReader", false, false),
			]
		} else {
			Vec::new()
		},
		guest:         (phase == SharePhase::Joined).then(|| ShareGuestView {
			room:      "r1".to_string(),
			host_name: Some("HostNode".to_string()),
			read_only: false,
			connected: true,
		}),
		error:         None,
	}
}

#[test]
fn each_share_phase_offers_only_the_controls_it_can_answer() {
	for phase in SharePhase::iter() {
		match phase {
			SharePhase::Off => {
				// 1. With relay configured
				let mut state_with_relay = ShareState::new();
				state_with_relay.share =
					Some(sample_share_view(phase, Some("https://relay.example.com")));
				assert!(has_relay(&state_with_relay));
				assert!(offers_start(&state_with_relay));
				assert!(!offers_stop(&state_with_relay));
				assert!(offers_join(&state_with_relay));
				assert!(!offers_leave(&state_with_relay));

				// 2. Without relay configured: hosting needs an address of its
				// own, and joining does not, because the link carries one.
				let mut state_no_relay = ShareState::new();
				state_no_relay.share = Some(sample_share_view(phase, None));
				assert!(!has_relay(&state_no_relay));
				assert!(!offers_start(&state_no_relay));
				assert!(!offers_stop(&state_no_relay));
				assert!(offers_join(&state_no_relay));
				assert!(!offers_leave(&state_no_relay));
			},
			SharePhase::Starting
			| SharePhase::Stopping
			| SharePhase::Joining
			| SharePhase::Leaving => {
				let mut state = ShareState::new();
				state.share = Some(sample_share_view(phase, Some("https://relay.example.com")));
				assert!(!offers_start(&state));
				assert!(!offers_stop(&state));
				assert!(!offers_join(&state));
				assert!(!offers_leave(&state));
			},
			SharePhase::Hosting => {
				let mut state = ShareState::new();
				state.share = Some(sample_share_view(phase, Some("https://relay.example.com")));
				assert!(!offers_start(&state));
				assert!(offers_stop(&state));
				assert!(!offers_join(&state));
				assert!(!offers_leave(&state));
				let view = state.share.as_ref().expect("hosting view present");
				assert_eq!(view.role, ShareRole::Hosting);
				assert!(view.link.is_some());
				assert!(view.view_link.is_some());
				assert_eq!(view.participants.len(), 3);
			},
			SharePhase::Joined => {
				let mut state = ShareState::new();
				state.share = Some(sample_share_view(phase, Some("https://relay.example.com")));
				assert!(!offers_start(&state));
				assert!(!offers_stop(&state));
				assert!(!offers_join(&state));
				assert!(offers_leave(&state));
				let view = state.share.as_ref().expect("joined view present");
				assert_eq!(view.role, ShareRole::Guest);
				let guest = view.guest.as_ref().expect("a joined view names its room");
				assert_eq!(guest.room, "r1");
				assert!(guest.connected);
				// A guest holds no room of its own to hand on.
				assert!(view.link.is_none());
			},
			SharePhase::Unknown => {
				let mut state = ShareState::new();
				state.share = Some(sample_share_view(phase, Some("https://relay.example.com")));
				assert!(!offers_start(&state));
				assert!(!offers_stop(&state));
				assert!(!offers_join(&state));
				assert!(!offers_leave(&state));
			},
		}
	}
}

#[test]
fn an_unknown_phase_word_draws_without_claiming_anything() {
	let mut state = ShareState::new();
	state.share = Some(ShareView {
		state:         "future_protocol_state".to_string(),
		role:          ShareRole::Off,
		relay_url:     Some("https://relay.example.com".to_string()),
		link:          None,
		web_link:      None,
		view_link:     None,
		web_view_link: None,
		participants:  Vec::new(),
		guest:         None,
		error:         None,
	});

	assert_eq!(state.phase(), SharePhase::Unknown);
	assert!(!offers_start(&state));
	assert!(!offers_stop(&state));
	assert!(!offers_join(&state));
	assert!(!offers_leave(&state));
}

#[test]
fn participant_row_states_whether_it_may_write() {
	let writer = sample_participant(1, "Alice", true, false);
	let reader = sample_participant(2, "Bob", false, false);
	let host = sample_participant(0, "Host", true, true);

	assert_eq!(participant_write_label(&writer), "can write");
	assert_eq!(participant_write_label(&reader), "read-only");
	assert_eq!(participant_write_label(&host), "can write");
	assert!(host.is_host);
	assert!(!writer.is_host);
}

/// Every address a room mints is drawn, and the set is read off the wire type
/// rather than listed here: a fifth link field added to `ShareView` and left
/// out of the card turns this red, which is the defect it closes — a link the
/// host sends and the window states nowhere is a room a guest cannot open.
#[test]
fn every_link_the_room_mints_is_one_the_card_states() {
	let view = sample_share_view(SharePhase::Hosting, Some("wss://relay.example.com"));
	let wire = serde_json::to_value(&view).expect("a share view serializes");
	let object = wire.as_object().expect("a share view is an object");

	let mut on_the_wire: Vec<&str> = object
		.iter()
		.filter(|(key, _)| key.ends_with("link"))
		.filter_map(|(_, value)| value.as_str())
		.collect();
	let mut on_the_card: Vec<&str> = link_rows(&view)
		.into_iter()
		.map(|(_, _, link)| link)
		.collect();
	on_the_wire.sort_unstable();
	on_the_card.sort_unstable();

	assert_eq!(on_the_card, on_the_wire);
	assert_eq!(
		link_rows(&view)
			.into_iter()
			.map(|(key, label, _)| (key, label))
			.collect::<Vec<_>>(),
		vec![
			("rw", "Share link"),
			("rw-web", "Browser link"),
			("ro", "Read-only link"),
			("ro-web", "Read-only browser link"),
		]
	);
}

/// A read-only share mints two of the four, and the card states those two
/// rather than drawing empty rows for the pair the host did not send.
#[test]
fn a_read_only_share_states_only_the_links_it_has() {
	let mut view = sample_share_view(SharePhase::Hosting, Some("wss://relay.example.com"));
	view.link = None;
	view.web_link = None;

	assert_eq!(
		link_rows(&view)
			.into_iter()
			.map(|(key, ..)| key)
			.collect::<Vec<_>>(),
		vec!["ro", "ro-web"]
	);
}
