//! Which regions a state change draws differently from the last one.
//!
//! The diff is a whole-state destructure rather than a set of dirty flags: a
//! field added to `ShellState` fails to compile here until it is assigned a
//! region or declared a full repaint. A field that went undiffed would change
//! pixels a scoped frame never repaints.

use super::{Invalidation, Region};
use crate::model::{ShellState, Turn};

/// The regions `next` draws differently from `last`.
///
/// The destructure is exhaustive on purpose: a field added to `ShellState`
/// fails to compile here until it is assigned a region or declared a full
/// repaint, which is the decision a new field owes this diff. A field that
/// went undiffed would change pixels a scoped frame never repaints.
pub fn regions_changed(last: &ShellState, next: &ShellState) -> Invalidation {
	let ShellState {
		title,
		navigation,
		navigation_pending,
		// The tab labels and draft markers reach no element since the tab
		// strip went (§4.1): the projection is carried for the host's
		// membership, so a change to it alone repaints nothing.
		session_tabs: _,
		sections,
		transcript,
		// The entry ids beside the turns draw nothing: they are read when the
		// window records where it is, so a change to them alone repaints
		// nothing.
		turn_anchors: _,
		turn,
		run_status,
		panel,
		cards,
		// A change in what a card's answers are gated by changes how every
		// answer row on the stack is drawn, so it repaints with the stack.
		card_answers,
		drawer,
		drawer_open,
		current_id,
		connection,
		controls,
		overlay,
		keymap,
		composer,
		reduced_motion,
		// Every ground, ink and tint is drawn from the theme, so a preview
		// the pointer raised changes pixels in every region at once.
		appearance,
		// The stack is drawn in a deferred layer over every region and
		// records no box of its own, so a card arriving or going repaints
		// what was under it.
		notices,
		// The freeze strip takes a line off the top of the window, so its
		// arrival and departure move every region under it, and while it
		// holds it draws from no box of its own. Its clock moves once a
		// second against agents that are all parked, so the repaint it costs
		// is a repaint of a window where nothing else is moving.
		paused,
		// The open menu is a float over the window with a scrim behind it,
		// drawn from no box of its own, and the titlebar's own section words
		// light with it.
		menu,
		// The catalogue is read when a command surface opens and drawn from
		// the overlay that opened, which is diffed above: a change to what
		// the host can run repaints nothing on its own.
		goal,
		goal_card_open,
		commands: _,
		providers: _,
	} = next;

	// Anything that moves layout, or changes a surface that records no box of
	// its own, repaints the window. The turn phase and the control states
	// reach the composer's footer and the titlebar's controls at once, and
	// the keymap state reaches every focused control.
	if current_id != &last.current_id
		|| navigation != &last.navigation
		|| navigation_pending != &last.navigation_pending
		|| drawer_open != &last.drawer_open
		|| panel.is_empty() != last.panel.is_empty()
		|| cards.is_empty() != last.cards.is_empty()
		|| card_answers != &last.card_answers
		|| turn != &last.turn
		|| connection != &last.connection
		|| controls != &last.controls
		|| overlay != &last.overlay
		|| keymap != &last.keymap
		|| composer != &last.composer
		|| reduced_motion != &last.reduced_motion
		|| appearance != &last.appearance
		|| notices != &last.notices
		|| paused != &last.paused
		|| menu != &last.menu
		|| goal != &last.goal
		|| goal_card_open != &last.goal_card_open
	{
		return Invalidation::Full;
	}

	let mut regions = Vec::new();
	if title != &last.title {
		regions.push(Region::Titlebar);
	}
	if sections != &last.sections {
		regions.push(Region::Queue);
	}
	transcript_regions(&last.transcript, transcript, &mut regions);
	if run_status != &last.run_status {
		regions.push(Region::RunBar);
	}
	if panel != &last.panel {
		regions.push(Region::Panel);
	}
	if cards != &last.cards {
		regions.push(Region::Cards);
	}
	if drawer != &last.drawer {
		regions.push(Region::Drawer);
	}

	// The tail of the transcript is what the composer's float blurs: the
	// float sits a hair below the last turn's box, and its backdrop blur
	// samples the gap between them. A change confined to the last turn still
	// changes pixels inside the float, so the regions below it repaint with
	// it. Without this a scoped frame either leaves the float stale or its
	// scissor slices the blur, which samples stale pixels across the cut.
	if regions.iter().any(
		|region| matches!(region, Region::Turn(index) if *index == transcript.len().saturating_sub(1)),
	) {
		if !cards.is_empty() {
			regions.push(Region::Cards);
		}
		regions.push(Region::Composer);
	}

	if regions.is_empty() {
		Invalidation::Nothing
	} else if overlay.is_some() {
		// The overlay's scrim blurs the whole columns row, so a change beneath
		// it reaches pixels far outside its own region. A scissor through a
		// blur samples stale pixels across the cut; the frame repaints whole.
		Invalidation::Full
	} else {
		Invalidation::Within(regions)
	}
}

/// The transcript's changed turns, by index.
///
/// A turn appended is its own region, and the turns it pushed up declare
/// themselves when they are prepainted into new boxes. A turn removed leaves
/// pixels no surviving turn is laid out over, so a shrink, and the switch from
/// the opening line to a column, repaint the whole body.
fn transcript_regions(last: &[Turn], next: &[Turn], regions: &mut Vec<Region>) {
	if next.len() < last.len() || last.is_empty() != next.is_empty() {
		if last != next {
			regions.push(Region::Transcript);
		}
		return;
	}
	regions.extend(
		next
			.iter()
			.enumerate()
			.filter(|(index, turn)| last.get(*index) != Some(*turn))
			.map(|(index, _)| Region::Turn(index)),
	);
}
