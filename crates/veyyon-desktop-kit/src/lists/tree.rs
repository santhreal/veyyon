//! Tree hierarchical navigation primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{
	AnyElement, App, ClickEvent, ElementId, IntoElement, Pixels, RenderOnce, SharedString, Window,
	div, prelude::*,
};

use crate::{
	icons::{Icon, IconName, IconSize},
	token_set::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet},
};

/// Row geometry a surface's panel tokens set. Unset fields fall back to the
/// kit's own spacing and type ramp.
#[derive(Debug, Clone, Copy, Default)]
pub struct TreeNodeMetrics {
	/// The row's fixed height; unset lets padding decide.
	pub row_height:  Option<Pixels>,
	/// Indent at depth zero.
	pub indent_base: Option<Pixels>,
	/// Indent added per depth level.
	pub indent_step: Option<Pixels>,
	/// Label size and line height.
	pub font:        Option<(Pixels, Pixels)>,
}

/// Hierarchical tree node element.
#[derive(IntoElement)]
pub struct TreeNode {
	id:          Option<ElementId>,
	label:       SharedString,
	depth:       usize,
	is_branch:   bool,
	is_expanded: bool,
	is_selected: bool,
	icon:        Option<IconName>,
	trailing:    Option<AnyElement>,
	metrics:     TreeNodeMetrics,
	on_toggle:   Option<Arc<dyn Fn(&ClickEvent, &mut Window, &mut App) + Send + Sync + 'static>>,
	on_click:    Option<Arc<dyn Fn(&ClickEvent, &mut Window, &mut App) + Send + Sync + 'static>>,
}

impl TreeNode {
	/// Creates a tree node with label and nesting depth.
	#[must_use]
	pub fn new(label: impl Into<SharedString>, depth: usize) -> Self {
		Self {
			id: None,
			label: label.into(),
			depth,
			is_branch: false,
			is_expanded: false,
			is_selected: false,
			icon: None,
			trailing: None,
			metrics: TreeNodeMetrics::default(),
			on_toggle: None,
			on_click: None,
		}
	}

	/// Sets element ID.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = Some(id.into());
		self
	}

	/// Sets whether node is a branch/directory or a leaf.
	#[must_use]
	pub fn branch(mut self, is_branch: bool) -> Self {
		self.is_branch = is_branch;
		self
	}

	/// Sets branch expansion state.
	#[must_use]
	pub fn expanded(mut self, is_expanded: bool) -> Self {
		self.is_expanded = is_expanded;
		self
	}

	/// Sets selection state.
	#[must_use]
	pub fn selected(mut self, is_selected: bool) -> Self {
		self.is_selected = is_selected;
		self
	}

	/// Sets leading node icon.
	#[must_use]
	pub fn icon(mut self, icon: IconName) -> Self {
		self.icon = Some(icon);
		self
	}

	/// Sets the trailing slot, drawn after the label at the row's end.
	#[must_use]
	pub fn trailing(mut self, element: impl IntoElement) -> Self {
		self.trailing = Some(element.into_any_element());
		self
	}

	/// Sets the row geometry a surface's panel tokens dictate.
	#[must_use]
	pub fn metrics(mut self, metrics: TreeNodeMetrics) -> Self {
		self.metrics = metrics;
		self
	}

	/// Sets branch expansion toggle callback. With it the chevron is its own
	/// control; without it the chevron is a glyph and the row's click is the
	/// only one.
	#[must_use]
	pub fn on_toggle(
		mut self,
		handler: impl Fn(&ClickEvent, &mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_toggle = Some(Arc::new(handler));
		self
	}

	/// Sets node row click callback.
	#[must_use]
	pub fn on_click(
		mut self,
		handler: impl Fn(&ClickEvent, &mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_click = Some(Arc::new(handler));
		self
	}
}

impl RenderOnce for TreeNode {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;

		let bg = if self.is_selected {
			tokens.row_selected()
		} else {
			tokens.transparent()
		};

		let depth = self.depth as f32;
		let step = self
			.metrics
			.indent_step
			.unwrap_or_else(|| tokens.spacing(SpacingStep::S4));
		let base = self
			.metrics
			.indent_base
			.unwrap_or_else(|| tokens.spacing(SpacingStep::S2));
		let indent = base + step * depth;
		let pad_x = tokens.spacing(SpacingStep::S2);
		let pad_y = tokens.spacing(SpacingStep::S1);
		let radius = tokens.radius(RadiusStep::Sm);
		let gap = tokens.spacing(SpacingStep::S2);
		let (font_size, line_height) = self
			.metrics
			.font
			.unwrap_or_else(|| (tokens.font_size(TextRamp::Body), tokens.line_height(TextRamp::Body)));

		let chevron = if self.is_branch {
			let icon_name = if self.is_expanded {
				IconName::ChevronDown
			} else {
				IconName::ChevronRight
			};
			let glyph = Icon::new(icon_name)
				.size(IconSize::Size12)
				.color(tokens.color(ColorRole::Secondary));
			match self.on_toggle {
				Some(handler) => div()
					.id(ElementId::from("tree-chevron"))
					.cursor_pointer()
					.on_click(move |ev, window, cx| handler(ev, window, cx))
					.child(glyph)
					.into_any_element(),
				None => div().child(glyph).into_any_element(),
			}
		} else {
			div()
				.size(tokens.spacing(SpacingStep::S3))
				.into_any_element()
		};

		let node_icon = self.icon.map(|icon_name| {
			Icon::new(icon_name)
				.size(IconSize::Size14)
				.color(tokens.color(ColorRole::Secondary))
		});

		let id = self.id.unwrap_or_else(|| ElementId::from("tree-node"));
		let mut el = div()
			.id(id)
			.w_full()
			.max_w_full()
			.min_w_0()
			.flex_shrink_0()
			.overflow_hidden()
			.bg(bg)
			.rounded(radius)
			.pl(indent)
			.pr(pad_x)
			.flex()
			.items_center()
			.gap(gap)
			.cursor_pointer()
			.hover(|s| s.bg(tokens.row_hover()))
			.child(chevron);
		el = match self.metrics.row_height {
			Some(height) => el.h(height),
			None => el.py(pad_y),
		};

		if let Some(icon) = node_icon {
			el = el.child(div().flex_shrink_0().child(icon));
		}

		el = el.child(
			div()
				.min_w_0()
				.flex_1()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.text_size(font_size)
				.line_height(line_height)
				.text_color(tokens.color(if self.is_selected {
					ColorRole::Foreground
				} else {
					ColorRole::Secondary
				}))
				.child(self.label),
		);

		if let Some(trailing) = self.trailing {
			el = el.child(div().flex_shrink_0().child(trailing));
		}

		if let Some(handler) = self.on_click {
			el = el.on_click(move |ev, window, cx| handler(ev, window, cx));
		}

		el
	}
}

/// Alias for `TreeNode` adhering to §6.7 naming.
pub type TreeRow = TreeNode;

/// Hierarchical tree container element rendering nodes through a builder
/// closure.
#[derive(IntoElement)]
pub struct Tree {
	id:          Option<ElementId>,
	root_count:  usize,
	render_node: Arc<dyn Fn(usize, &mut Window, &mut App) -> AnyElement + 'static>,
}

impl Tree {
	/// Creates a tree container with root item count and node builder.
	#[must_use]
	pub fn new(
		root_count: usize,
		render_node: impl Fn(usize, &mut Window, &mut App) -> AnyElement + 'static,
	) -> Self {
		Self { id: None, root_count, render_node: Arc::new(render_node) }
	}

	/// Sets an element id, which makes the tree a vertically scrolling
	/// container rather than a stack that clips.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = Some(id.into());
		self
	}
}

impl RenderOnce for Tree {
	fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;
		let gap = tokens.spacing(SpacingStep::S1);

		let nodes: Vec<AnyElement> = (0..self.root_count)
			.map(|idx| (self.render_node)(idx, window, cx))
			.collect();
		let container = div().w_full().flex().flex_col().gap(gap);
		match self.id {
			Some(id) => container
				.id(id)
				.flex_1()
				.overflow_y_scroll()
				.children(nodes)
				.into_any_element(),
			None => container.children(nodes).into_any_element(),
		}
	}
}
