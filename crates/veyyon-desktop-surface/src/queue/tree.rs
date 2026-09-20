//! What a rail row draws because it sits in a branch tree (§5.2).
//!
//! A card row and a line row draw the same three things for a tree: the
//! indent its depth earns, the chevron that folds it, and the note that
//! states a depth past the indent ceiling. One definition, so the two row
//! shapes cannot disagree about how deep a row looks or what folding it
//! writes.

use std::collections::{HashMap, HashSet};

use veyyon_desktop_kit::{
	ColorRole, RadiusStep, SpacingStep, TextRamp, TextWeight, TokenSet,
	controls::{IconButton, IconButtonVariant},
	icons::{IconName, IconSize},
};
use veyyon_desktop_tokens::QueueSurfaceTokens;
use veyyon_gpui::{Div, ElementId, ParentElement, SharedString, Styled, WeakEntity, div};

use crate::{Intent, ShellView, model::Row};

/// The branch each row sits in, and the branches that are folded.
///
/// Built once for the rows it is asked about, then read per row. A row that
/// searched the list for each of its ancestors cost the rail a scan per hop:
/// a thousand rows deep in a tree is a million comparisons for one frame.
pub struct Branches<'a> {
	/// The parent path of each occupied path.
	parent_of: HashMap<&'a str, &'a str>,
	/// Every path whose branch a projection marked folded.
	folded:    HashSet<&'a str>,
}

impl<'a> Branches<'a> {
	/// The branches `rows` form, in one pass over them.
	pub fn of(rows: impl Iterator<Item = &'a Row>) -> Self {
		let mut parent_of: HashMap<&'a str, &'a str> = HashMap::new();
		let mut folded: HashSet<&'a str> = HashSet::new();
		for row in rows {
			if let Some(parent) = row.parent_path.as_deref() {
				parent_of.insert(row.path.as_str(), parent);
			}
			if row.collapsed {
				folded.insert(row.path.as_str());
			}
		}
		Self { parent_of, folded }
	}

	/// Whether a folded branch above this row hides it.
	///
	/// A chain longer than the rows it was built from is a cycle in the paths
	/// the host sent, which ends the walk rather than hanging the frame.
	#[must_use]
	pub fn hidden(&self, row: &Row) -> bool {
		let mut ancestor = self.parent_of.get(row.path.as_str()).copied();
		let mut hops = 0;
		while let Some(path) = ancestor {
			if self.folded.contains(path) {
				return true;
			}
			hops += 1;
			if hops > self.parent_of.len() {
				break;
			}
			ancestor = self.parent_of.get(path).copied();
		}
		false
	}
}

/// The pixels a row is pushed in for its depth, bounded by the token ceiling.
///
/// Past the ceiling the indent stops: a rail 256px wide has no room to spend
/// on a tenth level, and the row states its depth in text instead.
#[must_use]
pub fn indent_px(row: &Row, geometry: &QueueSurfaceTokens) -> f32 {
	#[expect(
		clippy::cast_precision_loss,
		reason = "a depth bounded by tree_max_depth is a handful of levels"
	)]
	let depth = row.depth.min(geometry.tree_max_depth) as f32;
	depth * geometry.tree_indent_step_px
}

/// The note a row past the indent ceiling carries, stating its real depth.
#[must_use]
pub fn depth_note(row: &Row, geometry: &QueueSurfaceTokens, tokens: &TokenSet) -> Option<Div> {
	(row.depth > geometry.tree_max_depth).then(|| {
		div()
			.rounded(tokens.radius(RadiusStep::Sm))
			.px(tokens.spacing(SpacingStep::S1))
			.text_size(tokens.font_size(TextRamp::Micro))
			.line_height(tokens.line_height(TextRamp::Micro))
			.font_weight(tokens.font_weight(TextWeight::Medium))
			.text_color(tokens.color(ColorRole::Muted))
			.child(format!("depth {}", row.depth))
	})
}

/// The chevron that folds a parent row, absent on a row with no children.
///
/// The click raises the fold as an intent. The rail lists what a projection
/// produced, so the fold is recorded where the next projection reads it
/// rather than in the frame on screen, which the next host event replaces.
#[must_use]
pub fn collapse_control(
	element: &'static str,
	row: &Row,
	view: Option<&WeakEntity<ShellView>>,
) -> Option<IconButton> {
	if !row.is_parent {
		return None;
	}
	let icon = if row.collapsed {
		IconName::ChevronRight
	} else {
		IconName::ChevronDown
	};
	let mut button =
		IconButton::new(ElementId::NamedInteger(SharedString::new_static(element), row.id), icon)
			.size(IconSize::Size12)
			.variant(IconButtonVariant::Ghost);
	if let Some(weak) = view.cloned() {
		let path = row.path.clone();
		button = button.on_click(move |_event, _window, app| {
			// The rail row sits inside the row's own click target, which
			// opens the session.
			app.stop_propagation();
			let _ = weak.update(app, |view, cx| {
				view.dispatch(Intent::ToggleQueueParent(path.clone()), cx);
			});
		});
	}
	Some(button)
}
