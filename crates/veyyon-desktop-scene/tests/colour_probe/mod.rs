//! Sweep plumbing for the colour roles: repainting one role at a time and
//! naming the ones no frame inks.
//!
//! The measure sweep reaches numeric leaves only, so a colour is outside it
//! entirely. A test already asserts that a theme declares every role it
//! states and that each rendered pair clears its contrast floor, which
//! proves the file is complete and legible and proves nothing about
//! whether a surface ever draws the colour. A role nothing inks is a role an
//! operator can retheme with no effect: the same dead token, in the dimension
//! the numeric sweep cannot see.
//!
//! The mutation is a repaint rather than a nudge. A measure is doubled because
//! a layout reacts continuously to it; a colour either reaches a pixel or does
//! not, so the role is set to a colour far from every authored one and the
//! frame is compared by exact hash. One changed pixel is enough, which is what
//! makes a role drawn at a hairline's width or under a low opacity visible to
//! this sweep.
//!
//! WHAT IT DOES NOT CATCH. A role drawn only in a state no suite seeds reads
//! as dead here, which is the intended failure: the answer is to seed the
//! state, not to record an exemption. A role drawn in the right place with the
//! wrong meaning, `ErrorInk` on a row that succeeded, inks a pixel and passes.
//! Contrast and pairing stay with the theme's own suite.

use veyyon_desktop_scene::Headless;
use veyyon_desktop_tokens::{ColorRole, RgbColor, Theme, load_bundled_theme};

use crate::dead_token_probe::{Observation, Observed};

/// What a suite renders a theme into.
pub type ObserveFn = fn(&mut Headless, &Theme) -> Vec<Observation>;

/// A colour no authored role is near, so repainting a role with it moves every
/// pixel that role reaches.
const FAR: RgbColor = RgbColor::new(1.0, 0.0, 1.0, 1.0);

/// The second candidate, for the role that is already `FAR`.
const FARTHER: RgbColor = RgbColor::new(0.0, 1.0, 0.0, 1.0);

/// `theme` with `role` repainted to a colour it is not already.
#[must_use]
pub fn repaint(theme: &Theme, role: ColorRole) -> Theme {
	let mut next = theme.clone();
	let authored = next.roles.get(&role).copied();
	let replacement = if authored == Some(FAR) { FARTHER } else { FAR };
	next.roles.insert(role, replacement);
	next
}

/// Every role `observe` renders no pixel of, against a baseline already
/// rendered from the authored theme.
pub fn sweep(
	observe: ObserveFn,
	cx: &mut Headless,
	theme: &Theme,
	baseline: &Observed,
) -> Vec<ColorRole> {
	ColorRole::all()
		.into_iter()
		.filter(|role| &Observed::new(observe(cx, &repaint(theme, *role))) == baseline)
		.collect()
}

/// Fails naming every role no frame inks.
pub fn assert_every_role_is_inked(observe: ObserveFn) {
	assert_every_role_is_inked_except(observe, &[]);
}

/// Fails naming every role no frame inks, except the ones `covered` records as
/// reaching a pixel where this sweep cannot see them.
///
/// The comparison is exact in both directions, so a newly dead role fails and
/// a recorded one that starts inking fails until its row is dropped.
pub fn assert_every_role_is_inked_except(observe: ObserveFn, covered: &[(ColorRole, &str)]) {
	let theme = load_bundled_theme("dark").expect("the bundled dark theme must load");
	let mut cx = veyyon_desktop_scene::headless_context().expect("a Vulkan ICD is required");

	let observed = Observed::new(observe(&mut cx, &theme));
	// A blank frame compares equal to every other, so a sweep over one would
	// report every role inked while showing nothing.
	for observation in observed.frames() {
		match observation {
			Observation::Frame { name, distinct_values, .. } => assert!(
				*distinct_values > 1,
				"probe frame {name} drew one colour, so no repaint of it could be seen"
			),
			Observation::Report { name, text } => {
				assert!(!text.is_empty(), "probe report {name} is empty");
			},
		}
	}

	let mut dead = sweep(observe, &mut cx, &theme, &observed);
	dead.sort_by_key(|role| format!("{role:?}"));
	let mut recorded: Vec<ColorRole> = covered.iter().map(|(role, _)| *role).collect();
	recorded.sort_by_key(|role| format!("{role:?}"));
	assert_eq!(
		dead, recorded,
		"a role no frame inks is a colour the operator can change with no effect, and a recorded \
		 one that now inks is a row to drop: covered rows are {covered:?}"
	);
}
