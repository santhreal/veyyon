//! The immutable tree the box primitives assemble into, and the builder that
//! validates one.
//!
//! WHY THIS SPLIT: the parent module defines what a box is; this one defines
//! the arena that holds them, the parent-child validation, and the painted
//! extents cached at construction. The two change for different reasons — a new
//! paint field touches the box, a new structural invariant touches the builder.

use thiserror::Error;

use super::{BoxBounds, BoxId, LayoutBox, LayoutBoxSpec};

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
