//! The sharing chip opens the share the window is in: a hosted share lists
//! its guests and each link it offers, drawn whole and copied as it is; a
//! joined share lists its room; a window in no share draws no chip.

use gpui::TestAppContext;
use veyyon_desktop_model::domain::{ShareGuestView, ShareParticipantView, ShareRole, ShareView};

use super::{WINDOW, Win, share, stated, window};

/// The chip's driver target.
const CHIP: &str = "thread.share-links";

/// Four links, the first 80 characters long.
const LINKS: [&str; 4] = [
	"veyyon://relay.example.net/join/ab12cd34ef56?token=w-0123456789abcdef0123456789a",
	"https://relay.example.net/r/ab12cd34ef56#w-0123456789abcdef",
	"veyyon://relay.example.net/join/ab12cd34ef56?token=r-fedcba9876543210",
	"https://relay.example.net/r/ab12cd34ef56#r-fedcba9876543210",
];

/// The name the menu lists each link of [`LINKS`] under.
const NAMES: [&str; 4] =
	["Veyyon link", "Browser link", "Read-only veyyon link", "Read-only browser link"];

/// A party on the relay.
fn party(id: u64, is_host: bool) -> ShareParticipantView {
	ShareParticipantView { id, name: format!("party {id}"), can_write: true, is_host }
}

/// A hosted share offering the links of [`LINKS`] whose bit is set in
/// `offered`, to the host and two guests.
fn hosting(offered: u8) -> ShareView {
	let link = |n: usize| offers(offered, n).then(|| LINKS[n].to_owned());
	ShareView {
		link: link(0),
		web_link: link(1),
		view_link: link(2),
		web_view_link: link(3),
		participants: vec![party(0, true), party(1, false), party(2, false)],
		..share(ShareRole::Hosting)
	}
}

/// Whether the set `offered` holds link `n` of [`LINKS`].
const fn offers(offered: u8, n: usize) -> bool {
	((offered >> n) & 1) == 1
}

/// Opens the menu, picks its `row`th pickable row by key, and returns what
/// the clipboard holds after.
fn copy(w: &mut Win<'_>, row: usize) -> Option<String> {
	w.clear_clipboard();
	w.click(CHIP);
	w.keys(&vec!["down"; row + 1].join(" "));
	w.keys("enter");
	w.clipboard()
}

#[gpui::test]
fn every_link_a_hosted_share_offers_is_drawn_whole_and_copies_its_exact_value(
	app: &mut TestAppContext,
) {
	let mut w = window(app, Vec::new());
	for offered in 0..1u8 << LINKS.len() {
		w.apply(vec![stated(hosting(offered))]);
		w.click(CHIP);
		assert!(w.draws("2 guests"), "offering {offered:04b}: the menu counts the guests");
		let runs = w.runs();
		for (n, (link, name)) in LINKS.iter().zip(NAMES).enumerate() {
			let is_offered = offers(offered, n);
			let drawn = runs.iter().find(|(run, _)| run == link);
			assert_eq!(drawn.is_some(), is_offered, "offering {offered:04b}: {name} drawn");
			assert_eq!(w.draws(name), is_offered, "offering {offered:04b}: {name} named");
			if let Some((_, bounds)) = drawn {
				let right = f32::from(bounds.origin.x + bounds.size.width);
				assert!(
					f32::from(bounds.origin.x) >= 0.0 && right <= WINDOW.0,
					"offering {offered:04b}: {name} is drawn inside the window, not at {bounds:?}"
				);
			}
		}
		w.keys("escape");
		let expected = LINKS
			.iter()
			.enumerate()
			.filter(|(n, _)| offers(offered, *n));
		for (row, (_, link)) in expected.enumerate() {
			assert_eq!(copy(&mut w, row).as_deref(), Some(*link), "offering {offered:04b}: row {row}");
		}
	}
}

#[gpui::test]
fn a_window_in_no_share_draws_no_chip_and_a_share_that_ends_takes_it_away(
	app: &mut TestAppContext,
) {
	let mut w = window(app, Vec::new());
	assert_eq!(w.bounds(CHIP), None, "nothing stated");
	w.apply(vec![stated(share(ShareRole::Off))]);
	assert_eq!(w.bounds(CHIP), None, "sharing stated off");
	w.apply(vec![stated(hosting(0b1111))]);
	assert!(w.bounds(CHIP).is_some() && w.draws("Sharing"), "a hosted share draws its chip");
	w.apply(vec![stated(share(ShareRole::Off))]);
	assert_eq!(w.bounds(CHIP), None, "an ended share takes its chip away");
	assert!(!w.draws("Sharing"));
}

#[gpui::test]
fn an_open_menu_lists_the_links_the_host_states_now(app: &mut TestAppContext) {
	let mut w = window(app, vec![stated(hosting(0b0001))]);
	w.click(CHIP);
	assert!(w.draws(LINKS[0]));
	w.apply(vec![stated(hosting(0b0010))]);
	assert!(!w.draws(LINKS[0]), "a link the host no longer offers is not drawn");
	assert!(w.draws(LINKS[1]), "the link it offers now is");
	w.clear_clipboard();
	w.keys("down");
	w.keys("enter");
	assert_eq!(w.clipboard().as_deref(), Some(LINKS[1]), "and is what the open menu copies");
}

#[gpui::test]
fn a_joined_share_lists_its_room_and_copies_nothing(app: &mut TestAppContext) {
	let joined = ShareView {
		guest: Some(ShareGuestView {
			room:      "ab12cd34ef56".to_owned(),
			host_name: Some("build box".to_owned()),
			read_only: true,
			connected: true,
		}),
		..share(ShareRole::Guest)
	};
	let mut w = window(app, vec![stated(joined)]);
	assert!(w.draws("Joined"), "the chip names the side of the share");
	w.clear_clipboard();
	w.click(CHIP);
	for text in ["Joined build box", "ab12cd34ef56", "read-only"] {
		assert!(w.draws(text), "the menu draws {text}");
	}
	w.keys("down");
	w.keys("enter");
	assert_eq!(w.clipboard(), None, "the room row copies nothing");
}
