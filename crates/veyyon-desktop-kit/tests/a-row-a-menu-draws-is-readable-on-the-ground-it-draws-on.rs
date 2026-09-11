//! WHY: a menu drew a destructive row in `ErrorFill`, a fill colour used as
//! ink. `Delete` on a session card and `Kill (SIGKILL)` on a process row were
//! set at 1.12:1 against the float ground the menu draws on, so the one row
//! that destroys something was the one row nobody could read.
//!
//! The class this closes is a row tone drawn in a colour that cannot be read
//! on the menu's own ground, whichever role names it. Every tone a row
//! resolves to is swept off `MenuRowTone::iter()` and measured out of the
//! frame the menu drew, so a new tone is red here until it clears the §6.9
//! body floor, and a tone that stops marking itself is red too.
//!
//! What it does not catch: a row legible and wrong -- a destructive row set in
//! the approve tint reads fine and means the opposite -- and the icon and
//! shortcut columns, which this measures nothing of. It reads the label ink
//! alone.

use std::{collections::HashMap, error::Error, path::Path};

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{
	Menu, MenuItem, MenuRowTone, TokenSet,
	token_set::{ColorRole, RgbColor, SpacingStep, load_bundled_theme},
};
use veyyon_gpui::{
	App, AppContext, Context, IntoElement, ParentElement, Render, Styled, Window, div, px, size,
};

/// The label every arm draws, so one arm differs from another in ink alone and
/// the pixels that changed are the label's.
const LABEL: &str = "Delete this session";

/// §6.9's floor for text at body size and above. A menu row is
/// `TextRamp::Body`.
const BODY_FLOOR: f32 = 4.5;

/// The frame is drawn at twice scale so a glyph stem is more than one device
/// pixel wide and its core reaches the nominal ink rather than a blend of it.
const SCALE: f32 = 2.0;

/// One row of the tone under measurement, on the ground a menu floats over.
struct MenuRow {
	tone:        MenuRowTone,
	highlighted: bool,
}

impl Render for MenuRow {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let tokens = TokenSet::default();
		div()
			.size_full()
			.bg(tokens.color(ColorRole::Canvas))
			.p(tokens.spacing(SpacingStep::S4))
			.child(Menu::new([sample(self.tone).highlighted(self.highlighted)]))
	}
}

/// The row a tone is measured through.
///
/// The match is exhaustive, so a tone added to the kit stops this suite from
/// compiling until someone states what a row of it looks like.
fn sample(tone: MenuRowTone) -> MenuItem {
	let item = MenuItem::new(LABEL);
	match tone {
		MenuRowTone::Offered => item,
		MenuRowTone::Refused => item.disabled(true),
		MenuRowTone::Destructive => item.danger(true),
	}
}

/// The contrast one device pixel's colour makes against the menu's ground.
fn ratio(pixel: &[u8], ground: RgbColor) -> f32 {
	let channel = |index: usize| f32::from(pixel[index]) / 255.0;
	RgbColor::new(channel(0), channel(1), channel(2), 1.0).contrast_ratio(ground)
}

#[test]
fn every_tone_a_menu_row_draws_in_is_readable_on_the_ground_the_menu_draws_on()
-> Result<(), Box<dyn Error>> {
	let theme = load_bundled_theme("dark")?;
	let ground = theme.role(Path::new("dark"), ColorRole::Float)?;

	let mut cx = veyyon_desktop_kit::headless::app_context()?;
	let viewport = size(px(280.0), px(80.0));

	let mut drawn: Vec<(MenuRowTone, Vec<u8>)> = Vec::new();
	for tone in MenuRowTone::iter() {
		let frame = cx.render_frame(viewport, SCALE, move |_window, app: &mut App| {
			app.set_global(TokenSet::default());
			app.new(|_cx| MenuRow { tone, highlighted: false })
		})?;
		drawn.push((tone, frame.as_bytes().to_vec()));
	}

	let (_, offered) = drawn
		.iter()
		.find(|(tone, _)| *tone == MenuRowTone::Offered)
		.ok_or("MenuRowTone must offer an ordinary row")?;

	// The pixels that differ between an arm and the offered one are the
	// label's, because nothing else about the row changed: same label, same
	// icon gutter, same box. Their union is the ink every arm is read at, so
	// each arm is measured on the same pixels rather than on whatever its own
	// frame happens to make dark.
	let mut ink: Vec<usize> = Vec::new();
	for (tone, bytes) in &drawn {
		if *tone == MenuRowTone::Offered {
			continue;
		}
		assert_eq!(
			bytes.len(),
			offered.len(),
			"the {tone:?} arm drew a frame of a different size than the offered one",
		);
		let mut changed = 0_usize;
		for index in (0..bytes.len()).step_by(4) {
			if bytes[index..index + 3] != offered[index..index + 3] {
				changed += 1;
				ink.push(index);
			}
		}
		assert!(
			changed > 0,
			"the {tone:?} row drew the same pixels as an offered row, so nothing on screen states it \
			 is not one",
		);
	}
	ink.sort_unstable();
	ink.dedup();
	assert!(
		ink.len() > 20,
		"only {} pixels changed across every tone, too few to be a label's ink -- the arms are not \
		 drawing the row this suite measures",
		ink.len(),
	);

	for (tone, bytes) in &drawn {
		let peak = ink
			.iter()
			.map(|index| ratio(&bytes[*index..*index + 4], ground))
			.fold(1.0_f32, f32::max);
		assert!(
			peak >= BODY_FLOOR,
			"a {tone:?} menu row is drawn at {peak:.2}:1 against the float ground the menu fills \
			 with, under the {BODY_FLOOR}:1 §6.9 asks of text at body size, so the row cannot be read",
		);
	}

	Ok(())
}

/// The two marks a caller sets are independent, so a row can carry both: the
/// row menu refuses `Delete` while an answer is in flight, and it is
/// destructive as well. The product is swept because one ink has to win, and
/// the one that wins is refusal: a row drawn in error ink reads as a
/// destruction that is offered, which is the one thing a refused row is not.
#[test]
fn a_row_that_is_both_refused_and_destructive_states_the_refusal_first() {
	for disabled in [false, true] {
		for danger in [false, true] {
			let tone = MenuItem::new(LABEL)
				.disabled(disabled)
				.danger(danger)
				.tone();
			let expected = match (disabled, danger) {
				(true, _) => MenuRowTone::Refused,
				(false, true) => MenuRowTone::Destructive,
				(false, false) => MenuRowTone::Offered,
			};
			assert_eq!(
				tone, expected,
				"a row marked disabled={disabled} danger={danger} resolves to {tone:?}",
			);
		}
	}
}

/// WHY THIS ONE IS HERE: a menu walked with the arrows has no pointer in it, so
/// where the keyboard stands is drawn rather than hovered. It is drawn as the
/// fill every row surface selects with, and a fill behind a label is the one
/// change that can take the label's contrast under the floor while looking
/// deliberate.
///
/// The class this closes is a selected row nobody can read, and a selection
/// that draws nothing. The ground the label is measured against is read out of
/// the frame -- the colour most of the changed pixels came to -- rather than
/// recomputed from the tokens, so the reading is of what was drawn.
///
/// What it does not catch: which row the selection is on, which is the menu
/// bar's own suite in the surface crate.
#[test]
fn the_row_the_keyboard_stands_on_is_filled_and_still_readable() -> Result<(), Box<dyn Error>> {
	let mut cx = veyyon_desktop_kit::headless::app_context()?;
	let viewport = size(px(280.0), px(80.0));
	let mut frames: Vec<Vec<u8>> = Vec::new();
	for highlighted in [false, true] {
		let frame = cx.render_frame(viewport, SCALE, move |_window, app: &mut App| {
			app.set_global(TokenSet::default());
			app.new(|_cx| MenuRow { tone: MenuRowTone::Offered, highlighted })
		})?;
		frames.push(frame.as_bytes().to_vec());
	}
	let (plain, filled) = (&frames[0], &frames[1]);
	assert_eq!(plain.len(), filled.len(), "the two arms drew frames of different sizes");

	// The fill covers the row, so what changed is the row's own ground: a mark
	// set beside the label would move a handful of pixels instead.
	let mut tally: HashMap<[u8; 3], usize> = HashMap::new();
	let mut changed = 0_usize;
	for index in (0..plain.len()).step_by(4) {
		if plain[index..index + 3] != filled[index..index + 3] {
			changed += 1;
			let pixel = [filled[index], filled[index + 1], filled[index + 2]];
			*tally.entry(pixel).or_default() += 1;
		}
	}
	assert!(
		changed > 200,
		"a highlighted row changed {changed} pixels, too few to be a row's own fill, so a walk with \
		 no pointer in the window states nothing",
	);

	// Most of those pixels are the fill itself; the rest are the glyph edges
	// it antialiases against, which are fewer.
	let (fill, covered) = tally
		.into_iter()
		.max_by_key(|(_, count)| *count)
		.ok_or("the highlighted arm changed no pixel")?;
	assert!(
		covered * 2 > changed,
		"the commonest changed colour covers {covered} of {changed} changed pixels, so no one fill \
		 was drawn over the row",
	);
	let ground = RgbColor::new(
		f32::from(fill[0]) / 255.0,
		f32::from(fill[1]) / 255.0,
		f32::from(fill[2]) / 255.0,
		1.0,
	);

	// The label is what the fill did not repaint, so it is read against the
	// fill it now sits on.
	let peak = (0..filled.len())
		.step_by(4)
		.filter(|index| plain[*index..*index + 3] == filled[*index..*index + 3])
		.map(|index| ratio(&filled[index..index + 4], ground))
		.fold(1.0_f32, f32::max);
	assert!(
		peak >= BODY_FLOOR,
		"the row the keyboard stands on is drawn at {peak:.2}:1 against its own selected fill, \
		 under the {BODY_FLOOR}:1 §6.9 asks of body text",
	);

	Ok(())
}
