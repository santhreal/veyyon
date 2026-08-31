//! WHY THIS SUITE EXISTS. One editor backs every palette-shaped overlay, and
//! nothing emptied it or the query behind it when a palette closed. Reopening
//! the palette drew the filter of the palette that closed, over rows selected
//! by it: a reader who searched once and pressed escape came back to "No
//! commands found" and a field holding text they did not type, and typing again
//! appended to it, so every later search matched nothing either. The rows were
//! unreachable for the rest of the session.
//!
//! THE CLASS. Not "the command palette", but any overlay whose keyboard holder
//! is [`FocusTarget::Palette`], since all of them draw the one field over the
//! one query. Both halves are pinned: the query the store holds and the text
//! the field draws, which are separate values and were separately wrong. The
//! sweep is built from an exhaustive match over [`Overlay`], so a variant added
//! later fails to compile until it names a sample and lands in the sweep, and
//! the modes come from `PaletteMode::ALL` at run time.
//!
//! Overlays that hold no field of their own carry the negative control: an
//! approval or an image viewer opened over a palette must leave the filter
//! underneath it alone, or dismissing it would drop the search it covered.
//!
//! WHAT IT DOES NOT CATCH. Where the caret sits in a seeded field, and nothing
//! about appearance: the test platform has no display, so what the field shows
//! is read from the editor rather than from a frame.

use gpui::TestAppContext;
use veyyon_gui_core::{
	UiCommand,
	model::{EntryId, InteractionId, ProviderId, RequestId, SessionId},
	navigation::{Overlay, PaletteMode},
	palette,
	store::FocusTarget,
};

use crate::{
	shell::Shell,
	the_keyboard_reaches_every_route::{SECONDARY, open},
};

/// One sample of every overlay the window can open, paired with the pattern
/// that recognises it.
///
/// The generated match is exhaustive, so a variant added to `Overlay` stops
/// this file compiling until an arm names it, and the arm carries the sample
/// that arm's variant is swept with. A list written on its own would go stale
/// in silence, which is the same as having no sweep.
macro_rules! every_overlay {
	($($pattern:pat => $sample:expr),+ $(,)?) => {
		fn samples() -> Vec<Overlay> {
			vec![$($sample),+]
		}

		fn recognised(overlay: &Overlay) -> bool {
			match overlay {
				$($pattern => true),+
			}
		}
	};
}

every_overlay! {
	Overlay::CommandPalette { .. } => Overlay::CommandPalette { mode: PaletteMode::Commands },
	Overlay::ModelPicker => Overlay::ModelPicker,
	Overlay::QuickOpen => Overlay::QuickOpen,
	Overlay::SessionSwitcher => Overlay::SessionSwitcher,
	Overlay::ProviderAuth { .. } => Overlay::ProviderAuth { provider: provider() },
	Overlay::Approval { .. } => Overlay::Approval { interaction: interaction() },
	Overlay::Question { .. } => Overlay::Question { interaction: interaction() },
	Overlay::PlanReview { .. } => Overlay::PlanReview {
		request:     Some(RequestId::FIRST),
		interaction: None,
	},
	Overlay::RenameSession { .. } => Overlay::RenameSession {
		session: session(),
		value:   "Active session".to_owned(),
	},
	Overlay::Confirmation { .. } => Overlay::Confirmation {
		title:   "Delete".to_owned(),
		body:    "Deletes the session".to_owned(),
		confirm: Box::new(UiCommand::CloseTopOverlay),
	},
	Overlay::ImageViewer { .. } => Overlay::ImageViewer { entry: entry(), index: 0 },
}

fn provider() -> ProviderId {
	ProviderId::new("anthropic").expect("provider id is not empty")
}

fn interaction() -> InteractionId {
	InteractionId::new("interaction-1").expect("interaction id is not empty")
}

fn session() -> SessionId {
	SessionId::new("session-1").expect("session id is not empty")
}

fn entry() -> EntryId {
	EntryId::new("entry-1").expect("entry id is not empty")
}

/// The junk a reader leaves behind: long enough to match no row in any mode.
const STALE: &str = "query with no matching row 97f3";

/// Type a filter into the palette that is open, the way a reader does.
fn leave_a_filter_in_the_palette(
	shell: &gpui::Entity<Shell>,
	cx: &mut gpui::VisualTestContext,
	query: &str,
) {
	cx.simulate_keystrokes(&format!("{SECONDARY}-p"));
	cx.simulate_input(query);
	assert_eq!(
		shell.read_with(cx, |shell, _| shell.store.frontend.palette_query.clone()),
		query,
		"the field the palette drew did not reach the query the store holds"
	);
}

fn field_text(shell: &gpui::Entity<Shell>, cx: &mut gpui::VisualTestContext) -> String {
	shell.read_with(cx, |shell, cx| shell.handles.editors.command.read(cx).text().to_owned())
}

#[gpui::test]
fn every_palette_overlay_opens_on_an_empty_query(cx: &mut TestAppContext) {
	let palettes: Vec<Overlay> = samples()
		.into_iter()
		.filter(|overlay| {
			assert!(recognised(overlay), "the sweep carries a sample nothing recognises");
			matches!(overlay.keyboard(), Some(FocusTarget::Palette))
		})
		.collect();
	assert_eq!(palettes.len(), 4, "the palette-shaped overlays changed, so the sweep is stale");

	for overlay in palettes {
		let (shell, cx) = open(cx);
		leave_a_filter_in_the_palette(&shell, cx, STALE);
		cx.simulate_keystrokes("escape");

		cx.update(|window, cx| {
			shell.update(cx, |shell, cx| {
				shell.perform(UiCommand::OpenOverlay(overlay.clone()), window, cx);
			});
		});

		assert_eq!(
			shell.read_with(cx, |shell, _| shell.store.frontend.palette_query.clone()),
			"",
			"{overlay:?} opened on the filter of the palette that closed"
		);
		assert_eq!(
			shell.read_with(cx, |shell, _| shell.store.frontend.palette_cursor),
			0,
			"{overlay:?} opened on the row the previous filter had selected"
		);
		assert_eq!(
			field_text(&shell, cx),
			"",
			"{overlay:?} drew the text of the palette that closed"
		);
	}
}

#[gpui::test]
fn an_overlay_that_draws_no_field_leaves_the_filter_under_it(cx: &mut TestAppContext) {
	// The negative control. Emptying the query for every overlay would drop the
	// search a sheet was opened over, and the palette underneath would be
	// showing rows for a filter its own field no longer holds.
	for overlay in samples()
		.into_iter()
		.filter(|overlay| overlay.keyboard() != Some(FocusTarget::Palette))
	{
		let (shell, cx) = open(cx);
		leave_a_filter_in_the_palette(&shell, cx, "sess");

		cx.update(|window, cx| {
			shell.update(cx, |shell, cx| {
				shell.perform(UiCommand::OpenOverlay(overlay.clone()), window, cx);
			});
		});

		assert_eq!(
			shell.read_with(cx, |shell, _| shell.store.frontend.palette_query.clone()),
			"sess",
			"{overlay:?} emptied the filter of the palette it covered"
		);
	}
}

#[gpui::test]
fn a_reopened_palette_offers_the_rows_it_opened_with(cx: &mut TestAppContext) {
	// The reader-visible half, in every mode the palette has: a mode reopened
	// after a search that matched nothing offers what it offered the first
	// time. Counted per mode rather than asserted non-empty, because quick open
	// searches the workspace and legitimately has nothing to list until a
	// filter is typed, and a test that demands rows there would be reporting a
	// defect the product does not have.
	let (shell, cx) = open(cx);
	for mode in PaletteMode::ALL {
		let opened = rows(&shell, cx, mode);

		leave_a_filter_in_the_palette(&shell, cx, STALE);
		assert_eq!(
			rows(&shell, cx, mode),
			0,
			"{mode:?} matched the junk filter, so this proves nothing about reopening"
		);
		cx.simulate_keystrokes("escape");

		cx.update(|window, cx| {
			shell.update(cx, |shell, cx| {
				shell.perform(UiCommand::OpenOverlay(Overlay::CommandPalette { mode }), window, cx);
			});
		});

		assert_eq!(
			rows(&shell, cx, mode),
			opened,
			"{mode:?} reopened on a filter nobody typed into it"
		);
		cx.simulate_keystrokes("escape");
	}
}

/// The rows a mode offers for the query the store holds.
fn rows(shell: &gpui::Entity<Shell>, cx: &mut gpui::VisualTestContext, mode: PaletteMode) -> usize {
	shell.read_with(cx, |shell, _| {
		palette::results(&shell.store, mode, &shell.store.frontend.palette_query)
			.groups
			.iter()
			.map(|group| group.items.len())
			.sum()
	})
}

#[gpui::test]
fn the_next_character_typed_is_the_whole_filter(cx: &mut TestAppContext) {
	// The accumulation the defect produced: each search appended to the last,
	// so the third filter was three filters long and matched nothing whatever
	// was typed.
	let (shell, cx) = open(cx);
	leave_a_filter_in_the_palette(&shell, cx, STALE);
	cx.simulate_keystrokes("escape");

	cx.simulate_keystrokes(&format!("{SECONDARY}-p"));
	cx.simulate_input("s");

	assert_eq!(field_text(&shell, cx), "s", "the field appended to the filter of the last palette");
	assert_eq!(
		shell.read_with(cx, |shell, _| shell.store.frontend.palette_query.clone()),
		"s",
		"the query appended to the filter of the last palette"
	);
}
