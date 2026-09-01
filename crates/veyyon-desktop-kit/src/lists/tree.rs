//! Tree hierarchical navigation primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{
	AnyElement, App, ClickEvent, ElementId, IntoElement, RenderOnce, SharedString, Window, div,
	prelude::*,
};

use crate::{
	icons::{Icon, IconName, IconSize},
	token_set::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet},
};

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

	/// Sets branch expansion toggle callback.
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
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let bg = if self.is_selected {
			tokens.row_selected()
		} else {
			tokens.transparent()
		};

		let indent = tokens.spacing(SpacingStep::S4) * (self.depth as f32);
		let pad_x = tokens.spacing(SpacingStep::S2);
		let pad_y = tokens.spacing(SpacingStep::S1);
		let radius = tokens.radius(RadiusStep::Sm);
		let gap = tokens.spacing(SpacingStep::S2);

		let chevron = if self.is_branch {
			let icon_name = if self.is_expanded {
				IconName::ChevronDown
			} else {
				IconName::ChevronRight
			};
			let mut chevron_el = div()
				.id(ElementId::from("tree-chevron"))
				.cursor_pointer()
				.child(
					Icon::new(icon_name)
						.size(IconSize::Size12)
						.color(tokens.color(ColorRole::Secondary)),
				);

			if let Some(handler) = self.on_toggle {
				chevron_el = chevron_el.on_click(move |ev, window, cx| handler(ev, window, cx));
			}

			chevron_el.into_any_element()
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
			.overflow_hidden()
			.bg(bg)
			.rounded(radius)
			.pl(indent + pad_x)
			.pr(pad_x)
			.py(pad_y)
			.flex()
			.items_center()
			.gap(gap)
			.cursor_pointer()
			.child(chevron);

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
				.text_size(tokens.font_size(TextRamp::Body))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(self.label),
		);

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
	root_count:  usize,
	render_node: Arc<dyn Fn(usize, &mut Window, &mut App) -> AnyElement + Send + Sync + 'static>,
}

impl Tree {
	/// Creates a tree container with root item count and node builder.
	#[must_use]
	pub fn new(
		root_count: usize,
		render_node: impl Fn(usize, &mut Window, &mut App) -> AnyElement + Send + Sync + 'static,
	) -> Self {
		Self { root_count, render_node: Arc::new(render_node) }
	}
}

impl RenderOnce for Tree {
	fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);
		let gap = tokens.spacing(SpacingStep::S1);

		let mut container = div().w_full().flex().flex_col().gap(gap);
		for idx in 0..self.root_count {
			let node = (self.render_node)(idx, window, cx);
			container = container.child(node);
		}
		container
	}
}
