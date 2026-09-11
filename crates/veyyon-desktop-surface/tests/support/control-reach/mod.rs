//! How many controls a state puts on screen.
//!
//! Counted from the state and the tokens through the same functions the
//! surfaces draw from, so the expectation moves with the rule rather than
//! with a number kept in step by hand. It sits beside the suite that reads
//! it so the suite stays under the file ceiling.

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{document_spans, load_bundled_tokens};
use veyyon_desktop_surface::{Block, MenuSectionId, ShellState, Turn};

/// The window height the count is taken at, which decides how many queue
/// rows fit above the footer.
pub const HEIGHT: u32 = 900;

/// How many controls a state puts on screen.
///
/// Counted from the state and the tokens through the same functions the
/// surfaces use, so the expectation moves with the rule rather than with a
/// number kept in step by hand.
pub fn expected_controls(state: &ShellState) -> usize {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let queue = &tokens.surface.queue;
	let cards = &tokens.surface.attached_cards;

	// The native list renders partially visible rows as well as complete rows.
	// The fixed 32px navigation header precedes its viewport; the footer stays
	// outside it. Cards register the row, the hover container, and two actions.
	// Lines register the row, the hover container, and one restore action.
	let columns_px = HEIGHT as f32 - tokens.surface.shell.titlebar_height_px;
	let bottom = columns_px - queue.footer_height_px;
	let mut y = queue.content_inset + 32.0 + queue.section_gap_below;
	// The rail itself answers a click: it takes focus, which is what puts the
	// queue chords on the focus path.
	let mut queue_controls = 5; // Rail, search wrapper, search icon, new session, list
	for (section, rows) in &state.sections {
		if rows.is_empty() {
			continue;
		}
		if y < bottom {
			queue_controls += 1;
		}
		y += queue.section_gap_above + queue.section_header_px + queue.section_gap_below;
		let height = if section.draws_cards() {
			queue.card_px
		} else {
			queue.line_px
		};
		for _ in 0..veyyon_desktop_surface::queue::visible_rows(*section, rows.len(), queue) {
			if y < bottom {
				queue_controls += if section.draws_cards() { 4 } else { 3 };
			}
			y += height;
		}
	}

	// An empty contextual panel still has its docked split, and the panel's own
	// container answers a press because that is what puts its chords on the
	// focus path. The split answers two rects of its own: the grip that takes
	// the press, and the hairline inside it, whose tint turns on with the
	// grip's hover group, so it is hit-tested for the same reason a card's
	// revealed wrapper is. A diff has a scroll area, three toolbar controls and
	// one mode toggle per file. Each mono tenant answers one more rect per pane
	// it scrolls sideways (§5.11): the pinned gutter stays put and the code
	// beside it is its own scroll region, so a unified diff adds one per file, a
	// split diff adds two, and an open file adds one.
	let panes = match state.panel.diff_mode {
		veyyon_desktop_model::DiffMode::Unified => 1,
		veyyon_desktop_model::DiffMode::Split => 2,
	};
	// A hunk header answers a secondary press that states the file, the
	// lines the hunk covers and the symbol whole, so each one the pane
	// draws is a control of its own.
	let hunk_headers: usize = state
		.panel
		.diff
		.iter()
		.flat_map(|file| file.rows.iter())
		.filter(|row| matches!(row, veyyon_desktop_surface::DiffRow::HunkHeader { .. }))
		.count();
	let tenant = match state.panel.active_tab {
		veyyon_desktop_surface::PanelTab::Diff if !state.panel.is_empty() => {
			4 + state.panel.diff.len() * (1 + panes) + hunk_headers
		},
		veyyon_desktop_surface::PanelTab::File => usize::from(state.panel.file.is_some()),
		_ => 0,
	};
	let panel = if state.keymap.panel_collapsed {
		0
	} else {
		4 + state.panel.tabs.len() + tenant
	};

	// The overflow summary is hover-tested; each question also has a text reply.
	let visible_cards = cards.stack_max_visible.min(state.cards.len());
	let answers: usize = state
		.cards
		.iter()
		.take(visible_cards)
		.map(veyyon_desktop_surface::Card::answer_count)
		.sum::<usize>()
		+ usize::from(state.cards.len() > visible_cards);

	// Root, titlebar drag strip and toggles, rail settings, composer drop
	// target/editor, and the two tooltip-wrapped footer controls. A tooltip
	// answers one rect, its anchor's: the tag is drawn on the deferred layer
	// and is hit-tested for nothing.
	//
	// Two more answer a press for the keyboard rather than for a control: the
	// transcript body, which takes the focus its scope's chords ride on, and
	// the composer box, which hands the focus back to the editor whatever the
	// press landed on.
	// Each word of the menu bar answers a press of its own, counted from the
	// sections the bar draws rather than as a literal, so a menu added to the
	// table moves this with it.
	let menu_bar = MenuSectionId::iter().count();
	let chrome = 1
		+ 3 + 1
		+ 6 + 2
		+ usize::from(state.connection.is_attached())
		+ usize::from(state.current_id > 0) * 2;
	// A span the frame drew answers the pointer too, and a body behind a
	// disclosure row draws none until open: prose registers one per paragraph.
	let transcript = usize::from(!state.transcript.is_empty()) * 2
		+ state
			.transcript
			.iter()
			.map(|turn| match turn {
				Turn::Operator(text) => usize::from(!text.is_empty()),
				Turn::OperatorArtifacts { artifacts, text } => {
					artifacts.len() + usize::from(!text.is_empty())
				},
				Turn::Agent { blocks, model } => {
					blocks
						.iter()
						.map(|block| match block {
							Block::Prose(text) => document_spans(text).len(),
							Block::Note { .. } => 1,
							Block::Reason(_) | Block::Invoke { .. } | Block::Pane { .. } => 1,
							Block::Unknown { .. } | Block::Artifact(_) => 1,
						})
						.sum::<usize>()
						+ usize::from(model.is_some()) * 2
				},
			})
			.sum::<usize>();

	// Each attachment card answers three clicks: the card's own hover group,
	// the wrapper whose paint turns on with that hover (a `group_hover` style
	// is hit-tested so its reveal can be tracked), and the remove control the
	// hover reveals. The tray itself answers nothing. The refusal notice is
	// window-local state and so is counted by its own test below, not here.
	let tray = state.composer.attachments.len() * 3;

	queue_controls + panel + answers + chrome + menu_bar + tray + transcript
}
