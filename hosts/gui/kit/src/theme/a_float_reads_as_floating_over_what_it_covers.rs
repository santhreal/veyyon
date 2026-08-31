//! WHY THIS SUITE EXISTS.
//!
//! A floating surface used to state its own fill and its own shadow at each
//! site: a tooltip, a popover, a toast, a menu, a completion list, a sheet. Six
//! copies of two decisions, all of them the flat overlay ground, so a float
//! over a surface at the same luminance had a shadow and nothing else between
//! it and what it covered. On the light palette the shadow is half as dense,
//! and the overlay ground is white on a near-white canvas.
//!
//! THE CLASS. A float that reads as a card which happens to be on top: a face
//! that carries no light, an edge that is not there, a lift with no contact
//! shadow, and a fill so bright that the text on it stops being legible.
//!
//! The list of themes is read from the library at run time, so a theme added to
//! the library is swept here with no edit and fails until its float face clears
//! contrast at both ends.
//!
//! WHAT IT DOES NOT CATCH. Whether a compositor blurs behind the window, which
//! no assertion here can observe, and whether the sheen reads as glass to a
//! reader, which is what the recorded frames are for.

use veyyon_gui_core::navigation::font_size;

use super::{
	Appearance, contrast_ratio, entries,
	library::{composite_over, relative_luminance},
	opacity, scale,
};

/// Body text on a float has to clear WCAG AA at both ends of the face, not only
/// at the ground the face settles to.
const AA_BODY: f32 = 4.5;
/// Muted text is the large-text bar: a timestamp, a hint under a row.
const AA_MUTED: f32 = 3.0;

#[test]
fn a_float_face_carries_light_across_it_rather_than_one_flat_ground() {
	for entry in entries() {
		let theme = &entry.theme;
		let face = theme.float_face();
		assert_ne!(
			face.top, face.bottom,
			"theme `{}` float face is flat, so a float over a surface at its own luminance has \
			 nothing but a shadow to separate it",
			entry.name
		);
		assert_eq!(
			face.bottom, theme.overlay,
			"theme `{}` float face has to settle to the overlay ground it is a float of",
			entry.name
		);
		match theme.appearance {
			Appearance::Dark => assert!(
				face.top.l > face.bottom.l,
				"theme `{}` is dark, so the face catches light at the top: top {:.3} is not above \
				 bottom {:.3}",
				entry.name,
				face.top.l,
				face.bottom.l
			),
			Appearance::Light => assert!(
				face.top.l < face.bottom.l,
				"theme `{}` is light, so the face shades toward the top: top {:.3} is not below \
				 bottom {:.3}",
				entry.name,
				face.top.l,
				face.bottom.l
			),
		}
	}
}

#[test]
fn text_on_a_float_clears_contrast_at_both_ends_of_its_face() {
	for entry in entries() {
		let theme = &entry.theme;
		let face = theme.float_face();
		for (end, ground) in [("top", face.top), ("bottom", face.bottom)] {
			let body = contrast_ratio(theme.text, ground);
			assert!(
				body >= AA_BODY,
				"theme `{}` text on the float face's {end} is {body:.2}:1, under {AA_BODY:.2}:1",
				entry.name
			);
			let muted = contrast_ratio(theme.text_muted, ground);
			assert!(
				muted >= AA_MUTED,
				"theme `{}` muted text on the float face's {end} is {muted:.2}:1, under \
				 {AA_MUTED:.2}:1",
				entry.name
			);
		}
	}
}

#[test]
fn a_float_edge_is_visible_and_is_not_the_face_it_bounds() {
	for entry in entries() {
		let theme = &entry.theme;
		let edge = theme.float_edge();
		assert!(
			edge.a > 0.0 && edge.a <= 1.0,
			"theme `{}` float edge alpha {:.3} draws nothing",
			entry.name,
			edge.a
		);
		let face = theme.float_face();
		assert!(
			(edge.l - face.top.l).abs() > opacity::FLOAT_SHEEN_LIGHT,
			"theme `{}` float edge sits at the luminance of the face it bounds, so the boundary is \
			 the shadow alone",
			entry.name
		);
	}
}

#[test]
fn every_lift_a_float_takes_carries_a_contact_shadow_and_a_specular_hairline() {
	for entry in entries() {
		let theme = &entry.theme;
		for (name, lift, ambient) in [
			("menu", theme.lift_menu(), theme.shadow_menu()),
			("sheet", theme.lift_sheet(), theme.shadow_sheet()),
		] {
			assert_eq!(
				lift.len(),
				ambient.len() + 1,
				"theme `{}` {name} lift is the ambient shadows plus the hairline",
				entry.name
			);
			let inset: Vec<_> = lift.iter().filter(|shadow| shadow.inset).collect();
			assert_eq!(
				inset.len(),
				1,
				"theme `{}` {name} lift must carry exactly one inset hairline, the light along the \
				 float's top edge",
				entry.name
			);
			let hairline = inset[0];
			assert!(
				hairline.color.a > 0.0,
				"theme `{}` {name} hairline draws nothing at alpha {:.3}",
				entry.name,
				hairline.color.a
			);
			assert!(
				f32::from(hairline.offset.y) > 0.0,
				"theme `{}` {name} hairline has to sit inside the top edge, not on it",
				entry.name
			);
			let contact = lift
				.iter()
				.filter(|shadow| !shadow.inset)
				.any(|shadow| f32::from(shadow.blur_radius) <= 6.0);
			assert!(
				contact,
				"theme `{}` {name} lift has no tight contact shadow, so the float hovers with no \
				 weight on what it covers",
				entry.name
			);
		}
	}
}

/// A float's separation is physical distance, not type: the face, the edge and
/// the lift are the same at every interface size a reader can choose.
///
/// A shadow taken through the scale is the defect this rules out. At the
/// largest size the sheet's 48-pixel blur becomes 96, and a float that was
/// resting on the window is a card thrown clear of it; a hairline through the
/// same multiplier is two pixels of white inside a one-pixel border.
#[test]
fn the_float_treatment_holds_at_every_interface_size() {
	for entry in entries() {
		let theme = &entry.theme;
		let designed = (theme.float_face(), theme.float_edge(), theme.lift_sheet());
		for milli_px in font_size::CHOICES_MILLI_PX {
			scale::set_base_font(u32::from(milli_px));
			let face = theme.float_face();
			let held = (face, theme.float_edge(), theme.lift_sheet());
			scale::set_base_font(scale::DEFAULT_MILLI_PX);
			assert_eq!(
				held, designed,
				"theme `{}` float treatment moved at {milli_px} thousandths of a pixel; separation is \
				 distance, not text",
				entry.name
			);
			for (end, ground) in [("top", face.top), ("bottom", face.bottom)] {
				let body = contrast_ratio(theme.text, ground);
				assert!(
					body >= AA_BODY,
					"theme `{}` text on the float face's {end} is {body:.2}:1 at {milli_px} \
					 thousandths of a pixel",
					entry.name
				);
			}
		}
	}
}

/// The scrim a sheet lays over the window, and the boundary a float keeps
/// against every ground it can cover.
///
/// Separation is carried by one of two mechanisms, and which one depends on the
/// palette. On a light palette the float's face is near white and the scrimmed
/// window behind it is well below that, so the step in luminance is the
/// boundary. On a near-black palette every ground and the face are within a few
/// hundredths of each other, luminance ratios compress to nothing there, and
/// the edge is the boundary instead. A float that has neither is the defect:
/// the two surfaces meet and read as one.
///
/// The scrim is asserted as a scrim rather than as a token: it has to move
/// every ground further from the face than that ground was unscrimmed. One that
/// brightens what it covers, or that is too faint to change the comparison, is
/// a scrim in name only.
#[test]
fn every_ground_a_float_covers_keeps_a_step_or_an_edge_between_them() {
	/// The boundary either mechanism has to reach, as a WCAG ratio.
	const SEPARATION: f32 = 1.5;
	/// What a scrim has to take off the brightest ground it covers. A scrim
	/// that removes a hundredth of the window's light is a token, not a scrim:
	/// the float still sits on a lit backdrop and the reader has only the edge
	/// to go on.
	const DIMMED_TO: f32 = 0.75;
	for entry in entries() {
		let theme = &entry.theme;
		let scrim = theme.scrim();
		assert!(
			scrim.a > 0.0,
			"theme `{}` draws no scrim, so a sheet floats over an undimmed window",
			entry.name
		);
		// The face at its bottom, which is the worst case: the top carries the
		// sheen and is further from anything behind it.
		let face = theme.float_face().bottom;
		// The edge is drawn inside the float's own box, so it lands on the face.
		let edge = composite_over(theme.float_edge(), face);
		let grounds = [
			("canvas", theme.canvas),
			("chrome", theme.chrome),
			("raised", theme.raised),
			("sunken", theme.sunken),
			("overlay", theme.overlay),
		];
		for (name, ground) in grounds {
			let behind = composite_over(scrim, ground);
			assert!(
				contrast_ratio(face, behind) > contrast_ratio(face, ground),
				"theme `{}` scrim leaves the float no further from the {name} ground than it was \
				 undimmed",
				entry.name
			);
			assert!(
				relative_luminance(behind) < relative_luminance(face),
				"theme `{}` scrimmed {name} is brighter than the float over it, so the float reads as \
				 the hole rather than the surface",
				entry.name
			);
			let step = contrast_ratio(face, behind);
			let rim = contrast_ratio(edge, behind).min(contrast_ratio(edge, face));
			assert!(
				step >= SEPARATION || rim >= SEPARATION,
				"theme `{}` float over the scrimmed {name} has neither a step ({step:.2}:1) nor an \
				 edge ({rim:.2}:1) reaching {SEPARATION:.2}:1, so the two read as one surface",
				entry.name
			);
		}
		let (name, brightest) = grounds
			.into_iter()
			.fold(grounds[0], |brightest, candidate| {
				if relative_luminance(candidate.1) > relative_luminance(brightest.1) {
					candidate
				} else {
					brightest
				}
			});
		let lit = relative_luminance(brightest);
		let dimmed = relative_luminance(composite_over(scrim, brightest));
		assert!(
			dimmed <= lit * DIMMED_TO,
			"theme `{}` scrim takes the {name} ground from {lit:.3} to {dimmed:.3}, which is not the \
			 window going dim behind a sheet",
			entry.name
		);
	}
}
