//! Plain-data layout box tree captured from layout passes.
//!
//! WHY THIS TYPE LIVES HERE: gpui layout trees are tied to the window and
//! renderer context. To evaluate clutter metrics without linking gpui or
//! creating a window, the tree is captured into plain arena-allocated data.

use thiserror::Error;

use crate::frame::RgbaColor;

/// Identifier for a node in a [`LayoutBoxTree`].
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BoxId(pub u32);

/// Axis-aligned bounding rectangle in logical pixels.
#[derive(Copy, Clone, Debug, PartialEq, Default)]
pub struct BoxBounds {
	pub left:   f32,
	pub top:    f32,
	pub right:  f32,
	pub bottom: f32,
}

impl BoxBounds {
	pub const ZERO: Self = Self { left: 0.0, top: 0.0, right: 0.0, bottom: 0.0 };

	pub const fn new(left: f32, top: f32, right: f32, bottom: f32) -> Self {
		Self { left, top, right, bottom }
	}

	pub fn width(&self) -> f32 {
		(self.right - self.left).max(0.0)
	}

	pub fn height(&self) -> f32 {
		(self.bottom - self.top).max(0.0)
	}

	pub fn area(&self) -> f32 {
		self.width() * self.height()
	}

	pub fn center(&self) -> (f32, f32) {
		((self.left + self.right) * 0.5, (self.top + self.bottom) * 0.5)
	}

	pub const fn is_empty(&self) -> bool {
		self.left >= self.right || self.top >= self.bottom
	}

	pub fn intersects(&self, other: &Self) -> bool {
		self.left < other.right
			&& self.right > other.left
			&& self.top < other.bottom
			&& self.bottom > other.top
	}

	pub const fn union(&self, other: &Self) -> Self {
		let left = if self.left < other.left {
			self.left
		} else {
			other.left
		};
		let top = if self.top < other.top {
			self.top
		} else {
			other.top
		};
		let right = if self.right > other.right {
			self.right
		} else {
			other.right
		};
		let bottom = if self.bottom > other.bottom {
			self.bottom
		} else {
			other.bottom
		};
		Self { left, top, right, bottom }
	}

	pub fn overlap_y(&self, other: &Self) -> f32 {
		(self.bottom.min(other.bottom) - self.top.max(other.top)).max(0.0)
	}

	pub fn overlap_x(&self, other: &Self) -> f32 {
		(self.right.min(other.right) - self.left.max(other.left)).max(0.0)
	}
}
/// Border styling for a layout box.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct BorderPaint {
	pub width: f32,
	pub color: RgbaColor,
}

/// Divider orientation for a layout box.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum DividerAxis {
	Vertical,
	Horizontal,
}

/// Text styling and font size for a layout box.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct TextPaint {
	pub font_size: f32,
}

/// An individual layout node in a [`LayoutBoxTree`].
#[derive(Clone, Debug, PartialEq)]
pub struct LayoutBox {
	pub id:          BoxId,
	pub parent:      Option<BoxId>,
	pub children:    Vec<BoxId>,
	pub bounds:      BoxBounds,
	pub visible:     bool,
	pub interactive: bool,
	pub fill:        Option<RgbaColor>,
	pub border:      Option<BorderPaint>,
	pub divider:     Option<DividerAxis>,
	pub text:        Option<TextPaint>,
}

impl LayoutBox {
	/// True when the box renders visible ink.
	pub fn is_painted(&self) -> bool {
		if !self.visible {
			return false;
		}
		let has_fill = self.fill.is_some_and(|f| !f.is_invisible());
		let has_border = self
			.border
			.is_some_and(|b| b.width > 0.0 && !b.color.is_invisible());
		let has_divider = self.divider.is_some();
		let has_text = self.text.is_some();
		has_fill || has_border || has_divider || has_text
	}
}

/// Specification used to construct a [`LayoutBox`].
#[derive(Clone, Debug, PartialEq)]
pub struct LayoutBoxSpec {
	pub bounds:      BoxBounds,
	pub visible:     bool,
	pub interactive: bool,
	pub fill:        Option<RgbaColor>,
	pub border:      Option<BorderPaint>,
	pub divider:     Option<DividerAxis>,
	pub text:        Option<TextPaint>,
}

impl Default for LayoutBoxSpec {
	fn default() -> Self {
		Self {
			bounds:      BoxBounds::ZERO,
			visible:     true,
			interactive: false,
			fill:        None,
			border:      None,
			divider:     None,
			text:        None,
		}
	}
}

impl LayoutBoxSpec {
	pub const fn new() -> Self {
		Self {
			bounds:      BoxBounds::ZERO,
			visible:     true,
			interactive: false,
			fill:        None,
			border:      None,
			divider:     None,
			text:        None,
		}
	}

	pub const fn bounds(mut self, bounds: BoxBounds) -> Self {
		self.bounds = bounds;
		self
	}

	pub const fn rect(mut self, left: f32, top: f32, right: f32, bottom: f32) -> Self {
		self.bounds = BoxBounds::new(left, top, right, bottom);
		self
	}

	pub const fn visible(mut self, visible: bool) -> Self {
		self.visible = visible;
		self
	}

	pub const fn interactive(mut self, interactive: bool) -> Self {
		self.interactive = interactive;
		self
	}

	pub const fn fill(mut self, color: RgbaColor) -> Self {
		self.fill = Some(color);
		self
	}

	pub const fn border(mut self, width: f32, color: RgbaColor) -> Self {
		self.border = Some(BorderPaint { width, color });
		self
	}

	pub const fn divider(mut self, axis: DividerAxis) -> Self {
		self.divider = Some(axis);
		self
	}

	pub const fn text(mut self, font_size: f32) -> Self {
		self.text = Some(TextPaint { font_size });
		self
	}
}

/// Error returned when tree construction fails validation.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum LayoutError {
	#[error("parent id {0:?} was never pushed")]
	InvalidParent(BoxId),
	#[error("cycle detected at box {0:?}")]
	CycleDetected(BoxId),
}

/// Arena-allocated immutable layout box tree.
#[derive(Clone, Debug, PartialEq)]
pub struct LayoutBoxTree {
	boxes:           Vec<LayoutBox>,
	roots:           Vec<BoxId>,
	painted_extents: Vec<Option<BoxBounds>>,
}

impl LayoutBoxTree {
	/// Total number of boxes in the tree.
	pub const fn len(&self) -> usize {
		self.boxes.len()
	}

	/// True when the tree contains no boxes.
	pub const fn is_empty(&self) -> bool {
		self.boxes.is_empty()
	}

	/// Root box identifiers.
	pub fn roots(&self) -> &[BoxId] {
		&self.roots
	}

	/// Look up a box by its identifier.
	pub fn get(&self, id: BoxId) -> Option<&LayoutBox> {
		self.boxes.get(id.0 as usize)
	}

	/// Iterator over all boxes in arena order.
	pub fn iter(&self) -> impl Iterator<Item = &LayoutBox> {
		self.boxes.iter()
	}

	/// Children of the given box, or `None` if the box does not exist.
	pub fn children_of(&self, id: BoxId) -> Option<&[BoxId]> {
		self.get(id).map(|b| b.children.as_slice())
	}

	/// Cached union of this box's painted bounds and all painted descendant
	/// bounds.
	pub fn painted_extent(&self, id: BoxId) -> Option<BoxBounds> {
		self.painted_extents.get(id.0 as usize).copied().flatten()
	}

	/// Groups of sibling box identifiers (roots group plus each parent's
	/// children).
	pub fn sibling_groups(&self) -> Vec<Vec<BoxId>> {
		let mut groups = Vec::new();
		if !self.roots.is_empty() {
			groups.push(self.roots.clone());
		}
		for b in &self.boxes {
			if !b.children.is_empty() {
				groups.push(b.children.clone());
			}
		}
		groups
	}

	/// Iterator over visible text leaf boxes.
	pub fn text_leaves(&self) -> impl Iterator<Item = &LayoutBox> {
		self.boxes.iter().filter(|b| b.visible && b.text.is_some())
	}

	/// Iterator over visible interactive boxes.
	pub fn interactive_boxes(&self) -> impl Iterator<Item = &LayoutBox> {
		self.boxes.iter().filter(|b| b.visible && b.interactive)
	}

	/// Iterator over visible boxes that paint ink.
	pub fn painted_boxes(&self) -> impl Iterator<Item = &LayoutBox> {
		self.boxes.iter().filter(|b| b.is_painted())
	}
}

/// Builder for constructing a [`LayoutBoxTree`].
#[derive(Default)]
pub struct LayoutBoxTreeBuilder {
	specs: Vec<(Option<BoxId>, LayoutBoxSpec)>,
}

impl LayoutBoxTreeBuilder {
	pub const fn new() -> Self {
		Self { specs: Vec::new() }
	}

	/// Push a new box specification into the tree builder under an optional
	/// parent.
	pub fn push(&mut self, parent: Option<BoxId>, spec: LayoutBoxSpec) -> BoxId {
		let id = BoxId(self.specs.len() as u32);
		self.specs.push((parent, spec));
		id
	}

	/// Build and validate the immutable [`LayoutBoxTree`].
	pub fn build(self) -> Result<LayoutBoxTree, LayoutError> {
		let total = self.specs.len();
		let mut boxes = Vec::with_capacity(total);
		let mut roots = Vec::new();

		for (idx, (parent, spec)) in self.specs.iter().enumerate() {
			let id = BoxId(idx as u32);
			if let Some(p) = parent {
				if (p.0 as usize) >= total || p.0 == id.0 {
					return Err(LayoutError::InvalidParent(*p));
				}
			} else {
				roots.push(id);
			}

			boxes.push(LayoutBox {
				id,
				parent: *parent,
				children: Vec::new(),
				bounds: spec.bounds,
				visible: spec.visible,
				interactive: spec.interactive,
				fill: spec.fill,
				border: spec.border,
				divider: spec.divider,
				text: spec.text,
			});
		}

		// Populate parent-child links
		for idx in 0..total {
			let id = BoxId(idx as u32);
			if let Some(parent_box) = boxes
				.get(idx)
				.and_then(|b| b.parent)
				.and_then(|p| boxes.get_mut(p.0 as usize))
			{
				parent_box.children.push(id);
			}
		}

		// Cycle detection: walk ancestors from each node
		for idx in 0..total {
			let start = BoxId(idx as u32);
			let mut curr = Some(start);
			let mut steps = 0;
			while let Some(c) = curr {
				if steps > total {
					return Err(LayoutError::CycleDetected(start));
				}
				steps += 1;
				curr = boxes.get(c.0 as usize).and_then(|b| b.parent);
			}
		}

		// Precompute painted extents bottom-up
		let mut painted_extents: Vec<Option<BoxBounds>> = vec![None; total];
		let mut visited = vec![false; total];

		for idx in 0..total {
			let id = BoxId(idx as u32);
			compute_painted_extent(id, &boxes, &mut painted_extents, &mut visited);
		}

		Ok(LayoutBoxTree { boxes, roots, painted_extents })
	}
}

fn compute_painted_extent(
	id: BoxId,
	boxes: &[LayoutBox],
	extents: &mut [Option<BoxBounds>],
	visited: &mut [bool],
) -> Option<BoxBounds> {
	let idx = id.0 as usize;
	if matches!(visited.get(idx), Some(true)) {
		return extents.get(idx).copied().flatten();
	}
	if let Some(v) = visited.get_mut(idx) {
		*v = true;
	}

	let b = boxes.get(idx)?;
	let mut extent = if b.is_painted() { Some(b.bounds) } else { None };

	for child_id in &b.children {
		if let Some(child_extent) = compute_painted_extent(*child_id, boxes, extents, visited) {
			extent = match extent {
				Some(e) => Some(e.union(&child_extent)),
				None => Some(child_extent),
			};
		}
	}

	if let Some(slot) = extents.get_mut(idx) {
		*slot = extent;
	}

	extent
}
