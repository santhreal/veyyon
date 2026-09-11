//! WHY: `an-interaction-changes-the-state-and-reaches-the-host.rs` asserts that
//! an intent is reported to the host exactly when it is not local — and it
//! reads "not local" out of `Intent::is_local`, the very function that decides
//! whether the report happens. The two agree by construction, so moving a
//! variant into `is_local` leaves that suite green while the host stops
//! hearing the interaction. A rebind added to the local set was proved to
//! survive it: the settings overlay still changed under the operator's edit,
//! `keybindings.yml` was never written, and the next launch came back with the
//! old chord.
//!
//! CLASS CLOSED: a variant whose locality is wrong. The local set is pinned
//! here by exact equality against a space derived at run time from
//! `IntentDiscriminants`, so an addition to `is_local`, a removal from it, or a
//! variant deleted from the enum turns this red until the decision is recorded.
//! A newly added variant defaults to reported, which is the safe answer: it
//! reaches the host until someone states that the shell finishes it alone.
//!
//! NOT CAUGHT: whether a reported intent maps to the right host action, which
//! is `every-action-the-host-answers-has-a-control-that-sends-it.rs` in the
//! desktop crate, and whether the shell's own effect is the right one, which is
//! the state column of
//! `an-interaction-changes-the-state-and-reaches-the-host.rs`.

mod support;

use strum::IntoEnumIterator;
use support::intent_samples::every_intent;
use veyyon_desktop_surface::{Intent, IntentDiscriminants};

/// The interactions the shell finishes without the host: a scroll, a palette
/// keystroke, a disclosure, a copy. Nothing here changes what the host holds,
/// so nothing here is reported. The three menu-bar intents are here for the
/// same reason: which menu is down and which entry the keyboard is on is the
/// window's own, and the verb an entry takes reaches the host as that verb's
/// own intent, not as the press. `CloseWindow` and `Quit` are NOT here: the
/// window writes every store before it goes, so the report is what gives the
/// host the chance to. A workspace tab is NOT here: its selection is
/// window state, but the domain it draws is the host's and goes stale between
/// turns. The two appearance intents ARE here: which bundled theme the window
/// draws in is the window's own, written to its own store, and `SelectTheme`
/// beside them is the host's agent theme and is reported.
const LOCAL: [IntentDiscriminants; 24] = [
	IntentDiscriminants::CopyText,
	IntentDiscriminants::PreviewAppearance,
	IntentDiscriminants::SelectAppearance,
	IntentDiscriminants::Attach,
	IntentDiscriminants::RemoveAttachment,
	IntentDiscriminants::SelectDrawerTab,
	IntentDiscriminants::OpenOverlay,
	IntentDiscriminants::CloseOverlay,
	IntentDiscriminants::CloseTabOrPark,
	IntentDiscriminants::PaletteMove,
	IntentDiscriminants::PaletteQuery,
	IntentDiscriminants::FilterQueue,
	IntentDiscriminants::MoveQueueSelection,
	IntentDiscriminants::ScrollTranscript,
	IntentDiscriminants::FindInTranscript,
	IntentDiscriminants::StepTurn,
	IntentDiscriminants::ToggleBlock,
	IntentDiscriminants::ToggleQueue,
	IntentDiscriminants::SetDiffMode,
	IntentDiscriminants::ToggleTreeNode,
	IntentDiscriminants::ExpandContext,
	IntentDiscriminants::SetMenuSection,
	IntentDiscriminants::MoveMenuHighlight,
	IntentDiscriminants::MoveMenuSection,
];

/// The two whose locality depends on the payload: closing a region is the
/// window's own business, and opening one asks the host for what fills it.
const LOCAL_WHEN_CLOSING: [IntentDiscriminants; 2] =
	[IntentDiscriminants::SetDrawer, IntentDiscriminants::SetPanel];

/// What the pins say about `intent`, worked out without consulting
/// `Intent::is_local`.
fn pinned_local(intent: &Intent) -> bool {
	let disc = IntentDiscriminants::from(intent);
	if LOCAL.contains(&disc) {
		return true;
	}
	match intent {
		Intent::SetDrawer { open } | Intent::SetPanel { open } => !open,
		_ => false,
	}
}

#[test]
fn every_intent_agrees_with_the_pinned_local_set_and_nothing_else_is_local() {
	for intent in every_intent() {
		assert_eq!(
			intent.is_local(),
			pinned_local(&intent),
			"{intent:?} disagrees with the pinned local set: an intent the host must hear is local, \
			 or one the shell finishes alone is reported"
		);
	}

	// Both payloads of the two split variants, which one sample of each cannot
	// reach: a close is local and the open beside it is not.
	for (open, closing) in [(true, false), (false, true)] {
		assert_eq!(Intent::SetDrawer { open }.is_local(), closing);
		assert_eq!(Intent::SetPanel { open }.is_local(), closing);
	}
}

#[test]
fn every_pinned_discriminant_still_names_a_variant_of_the_enum() {
	let space: Vec<IntentDiscriminants> = IntentDiscriminants::iter().collect();
	let pinned: Vec<IntentDiscriminants> = LOCAL.into_iter().chain(LOCAL_WHEN_CLOSING).collect();

	let stale: Vec<IntentDiscriminants> = pinned
		.iter()
		.copied()
		.filter(|disc| !space.contains(disc))
		.collect();
	assert!(stale.is_empty(), "a pinned discriminant no longer names a variant: {stale:?}");

	let duplicated: Vec<IntentDiscriminants> = pinned
		.iter()
		.copied()
		.filter(|disc| pinned.iter().filter(|other| *other == disc).count() > 1)
		.collect();
	assert!(duplicated.is_empty(), "a discriminant is pinned twice: {duplicated:?}");
}

#[test]
fn every_variant_of_the_enum_is_sampled_so_none_escapes_the_sweep() {
	let sampled: Vec<IntentDiscriminants> = every_intent()
		.iter()
		.map(IntentDiscriminants::from)
		.collect();
	let unsampled: Vec<IntentDiscriminants> = IntentDiscriminants::iter()
		.filter(|disc| !sampled.contains(disc))
		.collect();

	assert!(
		unsampled.is_empty(),
		"unsampled intent variants, so their locality is unasserted: {unsampled:?}"
	);
}
