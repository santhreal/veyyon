// todo("windows"): remove
#![cfg_attr(windows, allow(dead_code))]

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    AtlasTextureId, AtlasTile, Background, Bounds, ContentMask, Corners, Edges, Hsla, Pixels,
    Point, Radians, ScaledPixels, Size, bounds_tree::BoundsTree, point, px, radians, size,
};
use smallvec::SmallVec;
use std::{
    fmt::Debug,
    iter::Peekable,
    ops::{Add, Range, Sub},
    slice,
};

#[allow(non_camel_case_types, unused)]
#[expect(missing_docs)]
pub type PathVertex_ScaledPixels = PathVertex<ScaledPixels>;

#[expect(missing_docs)]
pub type DrawOrder = u32;

/// A boolean stored as a `u32` so that GPU-facing structs contain no
/// compiler-inserted padding bytes, which would be undefined behavior to
/// reinterpret as `&[u8]` when writing instance buffers. Guaranteed to be
/// `0` or `1` by construction; shaders read it as a `u32`/`uint`.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
#[repr(transparent)]
pub struct PaddedBool32(u32);

impl From<bool> for PaddedBool32 {
    fn from(value: bool) -> Self {
        PaddedBool32(value as u32)
    }
}

/// One `(z_index, order)` pair per enclosing scope, root first. A layer's
/// children extend the layer's own key, so they sort after it and before the
/// next sibling of the layer; two primitives in one scope that do not overlap
/// share an order and keep batching together.
type SortKey = SmallVec<[(i32, DrawOrder); 4]>;

/// The paint scope a primitive is inserted into: the root, or one layer.
struct Scope {
    /// The key of the layer that opened this scope; empty at the root.
    prefix: SortKey,
    /// The z-index applied to primitives inserted directly in this scope.
    z_index: i32,
    /// Index into `Scene::bounds_trees`; a tree per open layer so that overlap
    /// inside a layer is ordered by paint sequence rather than by primitive kind.
    tree: usize,
}

/// Where one primitive sits in its kind's vector, with the key it sorts by.
struct Rank {
    key: SortKey,
    kind: PrimitiveKind,
    index: u32,
}

#[derive(Default)]
#[expect(missing_docs)]
pub struct Scene {
    pub(crate) paint_operations: Vec<PaintOperation>,
    bounds_trees: Vec<BoundsTree<ScaledPixels>>,
    scopes: Vec<Scope>,
    z_index_stack: Vec<i32>,
    ranks: Vec<Rank>,
    pub shadows: Vec<Shadow>,
    pub quads: Vec<Quad>,
    pub paths: Vec<Path<ScaledPixels>>,
    pub underlines: Vec<Underline>,
    pub monochrome_sprites: Vec<MonochromeSprite>,
    pub subpixel_sprites: Vec<SubpixelSprite>,
    pub polychrome_sprites: Vec<PolychromeSprite>,
    pub surfaces: Vec<PaintSurface>,
    pub backdrop_blurs: Vec<BackdropBlur>,
    pub start_path_clips: Vec<StartPathClip>,
    pub end_path_clips: Vec<EndPathClip>,
    pub damage: Option<Bounds<ScaledPixels>>,
}

#[expect(missing_docs)]
impl Scene {
    pub fn clear(&mut self) {
        self.paint_operations.clear();
        for tree in &mut self.bounds_trees {
            tree.clear();
        }
        self.scopes.clear();
        self.z_index_stack.clear();
        self.ranks.clear();
        self.paths.clear();
        self.shadows.clear();
        self.quads.clear();
        self.underlines.clear();
        self.subpixel_sprites.clear();
        self.monochrome_sprites.clear();
        self.polychrome_sprites.clear();
        self.surfaces.clear();
        self.backdrop_blurs.clear();
        self.start_path_clips.clear();
        self.end_path_clips.clear();
        self.damage = None;
    }

    pub fn len(&self) -> usize {
        self.paint_operations.len()
    }

    fn scope(&mut self) -> &mut Scope {
        if self.scopes.is_empty() {
            if self.bounds_trees.is_empty() {
                self.bounds_trees.push(BoundsTree::default());
            }
            self.scopes.push(Scope {
                prefix: SmallVec::new(),
                z_index: 0,
                tree: 0,
            });
        }
        let last = self.scopes.len() - 1;
        &mut self.scopes[last]
    }

    /// The key a primitive or layer with `bounds` gets in the current scope.
    fn key_for(&mut self, bounds: Bounds<ScaledPixels>) -> SortKey {
        let scope = self.scope();
        let tree = scope.tree;
        let z_index = scope.z_index;
        let mut key = scope.prefix.clone();
        let order = self.bounds_trees[tree].insert(bounds);
        key.push((z_index, order));
        key
    }

    pub fn push_layer(&mut self, bounds: Bounds<ScaledPixels>) {
        let prefix = self.key_for(bounds);
        let tree = self.scopes.len();
        if self.bounds_trees.len() <= tree {
            self.bounds_trees.push(BoundsTree::default());
        } else {
            self.bounds_trees[tree].clear();
        }
        self.scopes.push(Scope {
            prefix,
            z_index: 0,
            tree,
        });
        self.paint_operations
            .push(PaintOperation::StartLayer(bounds));
    }

    pub fn pop_layer(&mut self) {
        // The root scope is never popped: a layer is only ever popped by the
        // `with_content_mask` that pushed it, so a second scope exists here.
        if self.scopes.len() > 1 {
            self.scopes.pop();
        }
        self.paint_operations.push(PaintOperation::EndLayer);
    }

    /// Sorts primitives inserted until the matching `pop_z_index` at `z_index`
    /// within the current scope: above every primitive of the scope with a
    /// lower z-index and below every one with a higher, whatever their kind or
    /// paint sequence.
    pub fn push_z_index(&mut self, z_index: i32) {
        let scope = self.scope();
        let previous = std::mem::replace(&mut scope.z_index, z_index);
        self.z_index_stack.push(previous);
        self.paint_operations
            .push(PaintOperation::PushZIndex(z_index));
    }

    pub fn pop_z_index(&mut self) {
        if let Some(previous) = self.z_index_stack.pop() {
            self.scope().z_index = previous;
        }
        self.paint_operations.push(PaintOperation::PopZIndex);
    }

    /// Start a path-clipped subtree.
    pub fn push_path_clip(&mut self, path: Path<ScaledPixels>) {
        let bounds = path.transformation.apply_to_bounds(path.clipped_bounds());
        self.push_layer(bounds);
        let key = self.key_for(bounds);
        let index = self.start_path_clips.len() as u32;
        self.ranks.push(Rank {
            key,
            kind: PrimitiveKind::StartPathClip,
            index,
        });
        self.start_path_clips.push(StartPathClip {
            order: 0,
            path: path.clone(),
        });
        self.paint_operations
            .push(PaintOperation::StartPathClip(path));
    }

    /// End the innermost path-clipped subtree.
    pub fn pop_path_clip(&mut self) {
        let bounds = self
            .start_path_clips
            .last()
            .map(|c| {
                c.path
                    .transformation
                    .apply_to_bounds(c.path.clipped_bounds())
            })
            .unwrap_or_default();
        let key = self.key_for(bounds);
        let index = self.end_path_clips.len() as u32;
        self.ranks.push(Rank {
            key,
            kind: PrimitiveKind::EndPathClip,
            index,
        });
        self.end_path_clips.push(EndPathClip { order: 0 });
        self.paint_operations.push(PaintOperation::EndPathClip);
        self.pop_layer();
    }

    pub fn insert_primitive(&mut self, primitive: impl Into<Primitive>) {
        let mut primitive = primitive.into();
        let clipped_bounds = primitive
            .bounds()
            .intersect(&primitive.content_mask().bounds);

        if clipped_bounds.is_empty() {
            return;
        }

        let key = self.key_for(clipped_bounds);
        // Orders are provisional until `finish` derives dense draw orders from
        // the keys; this value only has to be a valid placeholder.
        let order = 0;
        let (kind, index) = match &primitive {
            Primitive::Shadow(_) => (PrimitiveKind::Shadow, self.shadows.len()),
            Primitive::Quad(_) => (PrimitiveKind::Quad, self.quads.len()),
            Primitive::Path(_) => (PrimitiveKind::Path, self.paths.len()),
            Primitive::Underline(_) => (PrimitiveKind::Underline, self.underlines.len()),
            Primitive::MonochromeSprite(_) => (
                PrimitiveKind::MonochromeSprite,
                self.monochrome_sprites.len(),
            ),
            Primitive::SubpixelSprite(_) => {
                (PrimitiveKind::SubpixelSprite, self.subpixel_sprites.len())
            }
            Primitive::PolychromeSprite(_) => (
                PrimitiveKind::PolychromeSprite,
                self.polychrome_sprites.len(),
            ),
            Primitive::Surface(_) => (PrimitiveKind::Surface, self.surfaces.len()),
            Primitive::BackdropBlur(_) => (PrimitiveKind::BackdropBlur, self.backdrop_blurs.len()),
        };
        self.ranks.push(Rank {
            key,
            kind,
            index: index as u32,
        });
        match &mut primitive {
            Primitive::Shadow(shadow) => {
                shadow.order = order;
                self.shadows.push(*shadow);
            }
            Primitive::Quad(quad) => {
                quad.order = order;
                self.quads.push(*quad);
            }
            Primitive::Path(path) => {
                path.order = order;
                path.id = PathId(self.paths.len());
                self.paths.push(path.clone());
            }
            Primitive::Underline(underline) => {
                underline.order = order;
                self.underlines.push(*underline);
            }
            Primitive::MonochromeSprite(sprite) => {
                sprite.order = order;
                self.monochrome_sprites.push(*sprite);
            }
            Primitive::SubpixelSprite(sprite) => {
                sprite.order = order;
                self.subpixel_sprites.push(*sprite);
            }
            Primitive::PolychromeSprite(sprite) => {
                sprite.order = order;
                self.polychrome_sprites.push(*sprite);
            }
            Primitive::Surface(surface) => {
                surface.order = order;
                self.surfaces.push(surface.clone());
            }
            Primitive::BackdropBlur(blur) => {
                blur.order = order;
                self.backdrop_blurs.push(*blur);
            }
        }
        self.paint_operations
            .push(PaintOperation::Primitive(primitive));
    }

    pub fn replay(&mut self, range: Range<usize>, prev_scene: &Scene) {
        for operation in &prev_scene.paint_operations[range] {
            match operation {
                PaintOperation::Primitive(primitive) => self.insert_primitive(primitive.clone()),
                PaintOperation::StartLayer(bounds) => self.push_layer(*bounds),
                PaintOperation::EndLayer => self.pop_layer(),
                PaintOperation::PushZIndex(z) => self.push_z_index(*z),
                PaintOperation::PopZIndex => self.pop_z_index(),
                PaintOperation::StartPathClip(path) => self.push_path_clip(path.clone()),
                PaintOperation::EndPathClip => self.pop_path_clip(),
            }
        }
    }

    pub fn finish(&mut self) {
        self.ranks.sort_unstable_by(|a, b| a.key.cmp(&b.key));
        let mut order: DrawOrder = 0;
        let mut previous_key: Option<&SortKey> = None;
        for rank in &self.ranks {
            if previous_key.is_some_and(|previous| previous != &rank.key) {
                order += 1;
            }
            previous_key = Some(&rank.key);
            let index = rank.index as usize;
            match rank.kind {
                PrimitiveKind::Shadow => self.shadows[index].order = order,
                PrimitiveKind::Quad => self.quads[index].order = order,
                PrimitiveKind::Path => self.paths[index].order = order,
                PrimitiveKind::Underline => self.underlines[index].order = order,
                PrimitiveKind::MonochromeSprite => self.monochrome_sprites[index].order = order,
                PrimitiveKind::SubpixelSprite => self.subpixel_sprites[index].order = order,
                PrimitiveKind::PolychromeSprite => self.polychrome_sprites[index].order = order,
                PrimitiveKind::Surface => self.surfaces[index].order = order,
                PrimitiveKind::BackdropBlur => self.backdrop_blurs[index].order = order,
                PrimitiveKind::StartPathClip => self.start_path_clips[index].order = order,
                PrimitiveKind::EndPathClip => self.end_path_clips[index].order = order,
            }
        }

        self.shadows.sort_by_key(|shadow| shadow.order);
        self.quads.sort_by_key(|quad| quad.order);
        self.paths.sort_by_key(|path| path.order);
        self.underlines.sort_by_key(|underline| underline.order);
        self.monochrome_sprites
            .sort_by_key(|sprite| (sprite.order, sprite.tile.tile_id));
        self.subpixel_sprites
            .sort_by_key(|sprite| (sprite.order, sprite.tile.tile_id));
        self.polychrome_sprites
            .sort_by_key(|sprite| (sprite.order, sprite.tile.tile_id));
        self.surfaces.sort_by_key(|surface| surface.order);
        self.backdrop_blurs.sort_by_key(|blur| blur.order);
        self.start_path_clips.sort_by_key(|clip| clip.order);
        self.end_path_clips.sort_by_key(|clip| clip.order);
    }

    #[cfg_attr(
        all(
            any(target_os = "linux", target_os = "freebsd"),
            not(any(feature = "x11", feature = "wayland"))
        ),
        allow(dead_code)
    )]
    pub fn batches(&self) -> impl Iterator<Item = PrimitiveBatch> + '_ {
        BatchIterator {
            shadows_start: 0,
            shadows_iter: self.shadows.iter().peekable(),
            quads_start: 0,
            quads_iter: self.quads.iter().peekable(),
            paths_start: 0,
            paths_iter: self.paths.iter().peekable(),
            underlines_start: 0,
            underlines_iter: self.underlines.iter().peekable(),
            monochrome_sprites_start: 0,
            monochrome_sprites_iter: self.monochrome_sprites.iter().peekable(),
            subpixel_sprites_start: 0,
            subpixel_sprites_iter: self.subpixel_sprites.iter().peekable(),
            polychrome_sprites_start: 0,
            polychrome_sprites_iter: self.polychrome_sprites.iter().peekable(),
            surfaces_start: 0,
            surfaces_iter: self.surfaces.iter().peekable(),
            backdrop_blurs_start: 0,
            backdrop_blurs_iter: self.backdrop_blurs.iter().peekable(),
            start_path_clips_iter: self.start_path_clips.iter().peekable(),
            end_path_clips_iter: self.end_path_clips.iter().peekable(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Default)]
#[cfg_attr(
    all(
        any(target_os = "linux", target_os = "freebsd"),
        not(any(feature = "x11", feature = "wayland"))
    ),
    allow(dead_code)
)]
pub(crate) enum PrimitiveKind {
    StartPathClip,
    Shadow,
    #[default]
    Quad,
    Path,
    Underline,
    MonochromeSprite,
    SubpixelSprite,
    PolychromeSprite,
    Surface,
    BackdropBlur,
    EndPathClip,
}

pub(crate) enum PaintOperation {
    Primitive(Primitive),
    StartLayer(Bounds<ScaledPixels>),
    EndLayer,
    PushZIndex(i32),
    PopZIndex,
    StartPathClip(Path<ScaledPixels>),
    EndPathClip,
}

#[derive(Clone)]
#[expect(missing_docs)]
pub enum Primitive {
    Shadow(Shadow),
    Quad(Quad),
    Path(Path<ScaledPixels>),
    Underline(Underline),
    MonochromeSprite(MonochromeSprite),
    SubpixelSprite(SubpixelSprite),
    PolychromeSprite(PolychromeSprite),
    Surface(PaintSurface),
    BackdropBlur(BackdropBlur),
}

#[expect(missing_docs)]
impl Primitive {
    pub fn bounds(&self) -> &Bounds<ScaledPixels> {
        match self {
            Primitive::Shadow(shadow) => &shadow.bounds,
            Primitive::Quad(quad) => &quad.bounds,
            Primitive::Path(path) => &path.bounds,
            Primitive::Underline(underline) => &underline.bounds,
            Primitive::MonochromeSprite(sprite) => &sprite.bounds,
            Primitive::SubpixelSprite(sprite) => &sprite.bounds,
            Primitive::PolychromeSprite(sprite) => &sprite.bounds,
            Primitive::Surface(surface) => &surface.bounds,
            Primitive::BackdropBlur(blur) => &blur.bounds,
        }
    }

    pub fn content_mask(&self) -> &ContentMask<ScaledPixels> {
        match self {
            Primitive::Shadow(shadow) => &shadow.content_mask,
            Primitive::Quad(quad) => &quad.content_mask,
            Primitive::Path(path) => &path.content_mask,
            Primitive::Underline(underline) => &underline.content_mask,
            Primitive::MonochromeSprite(sprite) => &sprite.content_mask,
            Primitive::SubpixelSprite(sprite) => &sprite.content_mask,
            Primitive::PolychromeSprite(sprite) => &sprite.content_mask,
            Primitive::Surface(surface) => &surface.content_mask,
            Primitive::BackdropBlur(blur) => &blur.content_mask,
        }
    }
}

#[cfg_attr(
    all(
        any(target_os = "linux", target_os = "freebsd"),
        not(any(feature = "x11", feature = "wayland"))
    ),
    allow(dead_code)
)]
struct BatchIterator<'a> {
    shadows_start: usize,
    shadows_iter: Peekable<slice::Iter<'a, Shadow>>,
    quads_start: usize,
    quads_iter: Peekable<slice::Iter<'a, Quad>>,
    paths_start: usize,
    paths_iter: Peekable<slice::Iter<'a, Path<ScaledPixels>>>,
    underlines_start: usize,
    underlines_iter: Peekable<slice::Iter<'a, Underline>>,
    monochrome_sprites_start: usize,
    monochrome_sprites_iter: Peekable<slice::Iter<'a, MonochromeSprite>>,
    subpixel_sprites_start: usize,
    subpixel_sprites_iter: Peekable<slice::Iter<'a, SubpixelSprite>>,
    polychrome_sprites_start: usize,
    polychrome_sprites_iter: Peekable<slice::Iter<'a, PolychromeSprite>>,
    surfaces_start: usize,
    surfaces_iter: Peekable<slice::Iter<'a, PaintSurface>>,
    backdrop_blurs_start: usize,
    backdrop_blurs_iter: Peekable<slice::Iter<'a, BackdropBlur>>,
    start_path_clips_iter: Peekable<slice::Iter<'a, StartPathClip>>,
    end_path_clips_iter: Peekable<slice::Iter<'a, EndPathClip>>,
}

impl<'a> Iterator for BatchIterator<'a> {
    type Item = PrimitiveBatch;

    fn next(&mut self) -> Option<Self::Item> {
        let mut orders_and_kinds = [
            (
                self.shadows_iter.peek().map(|s| s.order),
                PrimitiveKind::Shadow,
            ),
            (self.quads_iter.peek().map(|q| q.order), PrimitiveKind::Quad),
            (self.paths_iter.peek().map(|q| q.order), PrimitiveKind::Path),
            (
                self.underlines_iter.peek().map(|u| u.order),
                PrimitiveKind::Underline,
            ),
            (
                self.monochrome_sprites_iter.peek().map(|s| s.order),
                PrimitiveKind::MonochromeSprite,
            ),
            (
                self.subpixel_sprites_iter.peek().map(|s| s.order),
                PrimitiveKind::SubpixelSprite,
            ),
            (
                self.polychrome_sprites_iter.peek().map(|s| s.order),
                PrimitiveKind::PolychromeSprite,
            ),
            (
                self.surfaces_iter.peek().map(|s| s.order),
                PrimitiveKind::Surface,
            ),
            (
                self.backdrop_blurs_iter.peek().map(|b| b.order),
                PrimitiveKind::BackdropBlur,
            ),
            (
                self.start_path_clips_iter.peek().map(|c| c.order),
                PrimitiveKind::StartPathClip,
            ),
            (
                self.end_path_clips_iter.peek().map(|c| c.order),
                PrimitiveKind::EndPathClip,
            ),
        ];
        orders_and_kinds.sort_by_key(|(order, kind)| (order.unwrap_or(u32::MAX), *kind));

        let first = orders_and_kinds[0];
        let second = orders_and_kinds[1];
        let (batch_kind, max_order_and_kind) = if first.0.is_some() {
            (first.1, (second.0.unwrap_or(u32::MAX), second.1))
        } else {
            return None;
        };

        match batch_kind {
            PrimitiveKind::Shadow => {
                let shadows_start = self.shadows_start;
                let mut shadows_end = shadows_start + 1;
                self.shadows_iter.next();
                while self
                    .shadows_iter
                    .next_if(|shadow| (shadow.order, batch_kind) < max_order_and_kind)
                    .is_some()
                {
                    shadows_end += 1;
                }
                self.shadows_start = shadows_end;
                Some(PrimitiveBatch::Shadows(shadows_start..shadows_end))
            }
            PrimitiveKind::Quad => {
                let quads_start = self.quads_start;
                let mut quads_end = quads_start + 1;
                self.quads_iter.next();
                while self
                    .quads_iter
                    .next_if(|quad| (quad.order, batch_kind) < max_order_and_kind)
                    .is_some()
                {
                    quads_end += 1;
                }
                self.quads_start = quads_end;
                Some(PrimitiveBatch::Quads(quads_start..quads_end))
            }
            PrimitiveKind::Path => {
                let paths_start = self.paths_start;
                let mut paths_end = paths_start + 1;
                self.paths_iter.next();
                while self
                    .paths_iter
                    .next_if(|path| (path.order, batch_kind) < max_order_and_kind)
                    .is_some()
                {
                    paths_end += 1;
                }
                self.paths_start = paths_end;
                Some(PrimitiveBatch::Paths(paths_start..paths_end))
            }
            PrimitiveKind::Underline => {
                let underlines_start = self.underlines_start;
                let mut underlines_end = underlines_start + 1;
                self.underlines_iter.next();
                while self
                    .underlines_iter
                    .next_if(|underline| (underline.order, batch_kind) < max_order_and_kind)
                    .is_some()
                {
                    underlines_end += 1;
                }
                self.underlines_start = underlines_end;
                Some(PrimitiveBatch::Underlines(underlines_start..underlines_end))
            }
            PrimitiveKind::MonochromeSprite => {
                let texture_id = self.monochrome_sprites_iter.peek().unwrap().tile.texture_id;
                let sprites_start = self.monochrome_sprites_start;
                let mut sprites_end = sprites_start + 1;
                self.monochrome_sprites_iter.next();
                while self
                    .monochrome_sprites_iter
                    .next_if(|sprite| {
                        (sprite.order, batch_kind) < max_order_and_kind
                            && sprite.tile.texture_id == texture_id
                    })
                    .is_some()
                {
                    sprites_end += 1;
                }
                self.monochrome_sprites_start = sprites_end;
                Some(PrimitiveBatch::MonochromeSprites {
                    texture_id,
                    range: sprites_start..sprites_end,
                })
            }
            PrimitiveKind::SubpixelSprite => {
                let texture_id = self.subpixel_sprites_iter.peek().unwrap().tile.texture_id;
                let sprites_start = self.subpixel_sprites_start;
                let mut sprites_end = sprites_start + 1;
                self.subpixel_sprites_iter.next();
                while self
                    .subpixel_sprites_iter
                    .next_if(|sprite| {
                        (sprite.order, batch_kind) < max_order_and_kind
                            && sprite.tile.texture_id == texture_id
                    })
                    .is_some()
                {
                    sprites_end += 1;
                }
                self.subpixel_sprites_start = sprites_end;
                Some(PrimitiveBatch::SubpixelSprites {
                    texture_id,
                    range: sprites_start..sprites_end,
                })
            }
            PrimitiveKind::PolychromeSprite => {
                let texture_id = self.polychrome_sprites_iter.peek().unwrap().tile.texture_id;
                let sprites_start = self.polychrome_sprites_start;
                let mut sprites_end = sprites_start + 1;
                self.polychrome_sprites_iter.next();
                while self
                    .polychrome_sprites_iter
                    .next_if(|sprite| {
                        (sprite.order, batch_kind) < max_order_and_kind
                            && sprite.tile.texture_id == texture_id
                    })
                    .is_some()
                {
                    sprites_end += 1;
                }
                self.polychrome_sprites_start = sprites_end;
                Some(PrimitiveBatch::PolychromeSprites {
                    texture_id,
                    range: sprites_start..sprites_end,
                })
            }
            PrimitiveKind::Surface => {
                let surfaces_start = self.surfaces_start;
                let mut surfaces_end = surfaces_start + 1;
                self.surfaces_iter.next();
                while self
                    .surfaces_iter
                    .next_if(|surface| (surface.order, batch_kind) < max_order_and_kind)
                    .is_some()
                {
                    surfaces_end += 1;
                }
                self.surfaces_start = surfaces_end;
                Some(PrimitiveBatch::Surfaces(surfaces_start..surfaces_end))
            }
            PrimitiveKind::BackdropBlur => {
                let backdrop_blurs_start = self.backdrop_blurs_start;
                let mut backdrop_blurs_end = backdrop_blurs_start + 1;
                self.backdrop_blurs_iter.next();
                while self
                    .backdrop_blurs_iter
                    .next_if(|blur| (blur.order, batch_kind) < max_order_and_kind)
                    .is_some()
                {
                    backdrop_blurs_end += 1;
                }
                self.backdrop_blurs_start = backdrop_blurs_end;
                Some(PrimitiveBatch::BackdropBlurs(
                    backdrop_blurs_start..backdrop_blurs_end,
                ))
            }
            PrimitiveKind::StartPathClip => {
                let clip = self.start_path_clips_iter.next().unwrap();
                Some(PrimitiveBatch::StartPathClip(clip.path.clone()))
            }
            PrimitiveKind::EndPathClip => {
                self.end_path_clips_iter.next().unwrap();
                Some(PrimitiveBatch::EndPathClip)
            }
        }
    }
}

#[derive(Debug)]
#[cfg_attr(
    all(
        any(target_os = "linux", target_os = "freebsd"),
        not(any(feature = "x11", feature = "wayland"))
    ),
    allow(dead_code)
)]
#[allow(missing_docs)]
pub enum PrimitiveBatch {
    Shadows(Range<usize>),
    Quads(Range<usize>),
    Paths(Range<usize>),
    Underlines(Range<usize>),
    MonochromeSprites {
        texture_id: AtlasTextureId,
        range: Range<usize>,
    },
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    SubpixelSprites {
        texture_id: AtlasTextureId,
        range: Range<usize>,
    },
    PolychromeSprites {
        texture_id: AtlasTextureId,
        range: Range<usize>,
    },
    Surfaces(Range<usize>),
    BackdropBlurs(Range<usize>),
    StartPathClip(Path<ScaledPixels>),
    EndPathClip,
}

impl PrimitiveBatch {
    #[expect(missing_docs)]
    pub fn label(&self) -> String {
        match self {
            Self::Shadows(range) => format!("shadows ({})", range.len()),
            Self::Quads(range) => format!("quads ({})", range.len()),
            Self::Paths(range) => format!("paths ({})", range.len()),
            Self::Underlines(range) => format!("underlines ({})", range.len()),
            Self::MonochromeSprites { texture_id, range } => {
                format!(
                    "monochrome sprites ({}) on atlas {}",
                    range.len(),
                    texture_id.index
                )
            }
            Self::SubpixelSprites { texture_id, range } => {
                format!(
                    "subpixel sprites ({}) on atlas {}",
                    range.len(),
                    texture_id.index
                )
            }
            Self::PolychromeSprites { texture_id, range } => {
                format!(
                    "polychrome sprites ({}) on atlas {}",
                    range.len(),
                    texture_id.index
                )
            }
            Self::Surfaces(range) => format!("surfaces ({})", range.len()),
            Self::BackdropBlurs(range) => format!("backdrop blurs ({})", range.len()),
            Self::StartPathClip(_) => "start path clip".to_string(),
            Self::EndPathClip => "end path clip".to_string(),
        }
    }
}

/// Marker primitive opening a path-clipped subtree.
#[derive(Clone, Debug)]
pub struct StartPathClip {
    /// The draw order
    pub order: DrawOrder,
    /// The clipping path
    pub path: Path<ScaledPixels>,
}

/// Marker primitive closing a path-clipped subtree.
#[derive(Clone, Copy, Debug)]
pub struct EndPathClip {
    /// The draw order
    pub order: DrawOrder,
}

#[derive(Default, Debug, Copy, Clone)]
#[repr(C)]
#[expect(missing_docs)]
pub struct Quad {
    pub order: DrawOrder,
    pub border_style: BorderStyle,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub background: Background,
    pub border_color: Hsla,
    pub corner_radii: Corners<ScaledPixels>,
    pub border_widths: Edges<ScaledPixels>,
    pub transformation: TransformationMatrix,
}

impl From<Quad> for Primitive {
    fn from(quad: Quad) -> Self {
        Primitive::Quad(quad)
    }
}

#[derive(Debug, Copy, Clone)]
#[repr(C)]
#[expect(missing_docs)]
pub struct Underline {
    pub order: DrawOrder,
    pub pad: u32, // align to 8 bytes
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub color: Hsla,
    pub thickness: ScaledPixels,
    pub wavy: PaddedBool32,
    pub transformation: TransformationMatrix,
}

impl From<Underline> for Primitive {
    fn from(underline: Underline) -> Self {
        Primitive::Underline(underline)
    }
}

#[derive(Debug, Copy, Clone)]
#[repr(C)]
#[expect(missing_docs)]
pub struct Shadow {
    pub order: DrawOrder,
    pub blur_radius: ScaledPixels,
    pub bounds: Bounds<ScaledPixels>,
    pub corner_radii: Corners<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub color: Hsla,
    pub element_bounds: Bounds<ScaledPixels>,
    pub element_corner_radii: Corners<ScaledPixels>,
    /// 0 = drop shadow (rendered outside the element), 1 = inset shadow (rendered inside).
    pub inset: u32,
    pub pad: u32, // align to 8 bytes
    pub transformation: TransformationMatrix,
}
impl From<Shadow> for Primitive {
    fn from(shadow: Shadow) -> Self {
        Primitive::Shadow(shadow)
    }
}

#[derive(Debug, Copy, Clone)]
#[repr(C)]
#[expect(missing_docs)]
pub struct BackdropBlur {
    pub order: DrawOrder,
    pub pad: u32,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub corner_radii: Corners<ScaledPixels>,
    pub blur_radius: ScaledPixels,
    pub saturation: f32,
    pub tint: Hsla,
    pub transformation: TransformationMatrix,
}

impl From<BackdropBlur> for Primitive {
    fn from(blur: BackdropBlur) -> Self {
        Primitive::BackdropBlur(blur)
    }
}

/// The style of a border.
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[repr(C)]
pub enum BorderStyle {
    /// A solid border.
    #[default]
    Solid = 0,
    /// A dashed border.
    Dashed = 1,
}

/// A transformation to apply to an element.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Transformation {
    /// Scaling factor along x and y axes.
    pub scale: Size<f32>,
    /// Translation offset.
    pub translate: Point<Pixels>,
    /// Rotation angle in radians.
    pub rotate: Radians,
    /// Transform origin. If None, the center of the element bounds is used.
    pub origin: Option<Point<Pixels>>,
}

impl Default for Transformation {
    fn default() -> Self {
        Self {
            scale: size(1.0, 1.0),
            translate: point(px(0.0), px(0.0)),
            rotate: radians(0.0),
            origin: None,
        }
    }
}

impl Transformation {
    /// Create an identity transformation.
    pub fn unit() -> Self {
        Self::default()
    }

    /// Create a transformation with the specified scale along each axis.
    pub fn scale(scale: Size<f32>) -> Self {
        Self {
            scale,
            translate: point(px(0.0), px(0.0)),
            rotate: radians(0.0),
            origin: None,
        }
    }

    /// Create a transformation with uniform scaling.
    pub fn uniform_scale(factor: f32) -> Self {
        Self::scale(size(factor, factor))
    }

    /// Create a transformation with the specified translation.
    pub fn translate(translate: Point<Pixels>) -> Self {
        Self {
            scale: size(1.0, 1.0),
            translate,
            rotate: radians(0.0),
            origin: None,
        }
    }

    /// Create a transformation with the specified rotation in radians.
    pub fn rotate(rotate: impl Into<Radians>) -> Self {
        Self {
            scale: size(1.0, 1.0),
            translate: point(px(0.0), px(0.0)),
            rotate: rotate.into(),
            origin: None,
        }
    }

    /// Set the transform origin.
    pub fn with_origin(mut self, origin: Point<Pixels>) -> Self {
        self.origin = Some(origin);
        self
    }

    /// Update the scaling factor of this transformation.
    pub fn with_scaling(mut self, scale: Size<f32>) -> Self {
        self.scale = scale;
        self
    }

    /// Update the translation value of this transformation.
    pub fn with_translation(mut self, translate: Point<Pixels>) -> Self {
        self.translate = translate;
        self
    }

    /// Update the rotation angle of this transformation.
    pub fn with_rotation(mut self, rotate: impl Into<Radians>) -> Self {
        self.rotate = rotate.into();
        self
    }

    /// Convert this transformation into a 2x3 affine matrix for rendering.
    pub fn into_matrix(self, center: Point<Pixels>, scale_factor: f32) -> TransformationMatrix {
        let center = self.origin.unwrap_or(center);
        TransformationMatrix::unit()
            .translate(center.scale(scale_factor) + self.translate.scale(scale_factor))
            .rotate(self.rotate)
            .scale(self.scale)
            .translate(center.scale(-scale_factor))
    }

    /// Linearly interpolate between this and another transformation.
    pub fn lerp(self, other: Self, t: f32) -> Self {
        let t = t.clamp(0.0, 1.0);
        Self {
            scale: crate::size(
                self.scale.width + (other.scale.width - self.scale.width) * t,
                self.scale.height + (other.scale.height - self.scale.height) * t,
            ),
            translate: crate::point(
                crate::px(self.translate.x.0 + (other.translate.x.0 - self.translate.x.0) * t),
                crate::px(self.translate.y.0 + (other.translate.y.0 - self.translate.y.0) * t),
            ),
            rotate: crate::radians(self.rotate.0 + (other.rotate.0 - self.rotate.0) * t),
            origin: other.origin.or(self.origin),
        }
    }
}

/// A data type representing a 2 dimensional transformation that can be applied to an element.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[repr(C)]
pub struct TransformationMatrix {
    /// 2x2 matrix containing rotation and scale,
    /// stored row-major
    pub rotation_scale: [[f32; 2]; 2],
    /// translation vector
    pub translation: [f32; 2],
}

impl Eq for TransformationMatrix {}

impl TransformationMatrix {
    /// The unit matrix, has no effect.
    pub fn unit() -> Self {
        Self {
            rotation_scale: [[1.0, 0.0], [0.0, 1.0]],
            translation: [0.0, 0.0],
        }
    }

    /// Move the origin by a given point
    pub fn translate(mut self, point: Point<ScaledPixels>) -> Self {
        self.compose(Self {
            rotation_scale: [[1.0, 0.0], [0.0, 1.0]],
            translation: [point.x.0, point.y.0],
        })
    }

    /// Clockwise rotation in radians around the origin
    pub fn rotate(self, angle: Radians) -> Self {
        self.compose(Self {
            rotation_scale: [
                [angle.0.cos(), -angle.0.sin()],
                [angle.0.sin(), angle.0.cos()],
            ],
            translation: [0.0, 0.0],
        })
    }

    /// Scale around the origin
    pub fn scale(self, size: Size<f32>) -> Self {
        self.compose(Self {
            rotation_scale: [[size.width, 0.0], [0.0, size.height]],
            translation: [0.0, 0.0],
        })
    }

    /// Perform matrix multiplication with another transformation
    /// to produce a new transformation that is the result of
    /// applying both transformations: first, `other`, then `self`.
    #[inline]
    pub fn compose(self, other: TransformationMatrix) -> TransformationMatrix {
        if other == Self::unit() {
            return self;
        }
        // Perform matrix multiplication
        TransformationMatrix {
            rotation_scale: [
                [
                    self.rotation_scale[0][0] * other.rotation_scale[0][0]
                        + self.rotation_scale[0][1] * other.rotation_scale[1][0],
                    self.rotation_scale[0][0] * other.rotation_scale[0][1]
                        + self.rotation_scale[0][1] * other.rotation_scale[1][1],
                ],
                [
                    self.rotation_scale[1][0] * other.rotation_scale[0][0]
                        + self.rotation_scale[1][1] * other.rotation_scale[1][0],
                    self.rotation_scale[1][0] * other.rotation_scale[0][1]
                        + self.rotation_scale[1][1] * other.rotation_scale[1][1],
                ],
            ],
            translation: [
                self.translation[0]
                    + self.rotation_scale[0][0] * other.translation[0]
                    + self.rotation_scale[0][1] * other.translation[1],
                self.translation[1]
                    + self.rotation_scale[1][0] * other.translation[0]
                    + self.rotation_scale[1][1] * other.translation[1],
            ],
        }
    }

    /// Apply transformation to a point, mainly useful for debugging
    pub fn apply(&self, point: Point<Pixels>) -> Point<Pixels> {
        let input = [point.x.0, point.y.0];
        let mut output = self.translation;
        for (i, output_cell) in output.iter_mut().enumerate() {
            for (k, input_cell) in input.iter().enumerate() {
                *output_cell += self.rotation_scale[i][k] * *input_cell;
            }
        }
        Point::new(output[0].into(), output[1].into())
    }

    /// Apply transformation to a point in scaled pixels.
    pub fn apply_scaled(&self, point: Point<ScaledPixels>) -> Point<ScaledPixels> {
        let input = [point.x.0, point.y.0];
        let mut output = self.translation;
        for (i, output_cell) in output.iter_mut().enumerate() {
            for (k, input_cell) in input.iter().enumerate() {
                *output_cell += self.rotation_scale[i][k] * *input_cell;
            }
        }
        Point::new(ScaledPixels(output[0]), ScaledPixels(output[1]))
    }

    /// Apply this transformation to the 4 corners of a bounding box and return the
    /// axis-aligned bounding box that encloses the transformed corners.
    pub fn apply_to_bounds(&self, bounds: Bounds<ScaledPixels>) -> Bounds<ScaledPixels> {
        if *self == Self::unit() {
            return bounds;
        }
        let tl = self.apply_scaled(bounds.origin);
        let tr = self.apply_scaled(point(bounds.right(), bounds.top()));
        let br = self.apply_scaled(point(bounds.right(), bounds.bottom()));
        let bl = self.apply_scaled(point(bounds.left(), bounds.bottom()));

        let min_x = tl.x.min(tr.x).min(br.x).min(bl.x);
        let max_x = tl.x.max(tr.x).max(br.x).max(bl.x);
        let min_y = tl.y.min(tr.y).min(br.y).min(bl.y);
        let max_y = tl.y.max(tr.y).max(br.y).max(bl.y);

        Bounds {
            origin: point(min_x, min_y),
            size: size(max_x - min_x, max_y - min_y),
        }
    }
}

impl Default for TransformationMatrix {
    fn default() -> Self {
        Self::unit()
    }
}

#[derive(Copy, Clone, Debug)]
#[repr(C)]
#[expect(missing_docs)]
pub struct MonochromeSprite {
    pub order: DrawOrder,
    pub pad: u32,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub color: Hsla,
    pub tile: AtlasTile,
    pub transformation: TransformationMatrix,
}

impl From<MonochromeSprite> for Primitive {
    fn from(sprite: MonochromeSprite) -> Self {
        Primitive::MonochromeSprite(sprite)
    }
}

#[derive(Copy, Clone, Debug)]
#[repr(C)]
#[expect(missing_docs)]
pub struct SubpixelSprite {
    pub order: DrawOrder,
    pub pad: u32, // align to 8 bytes
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub color: Hsla,
    pub tile: AtlasTile,
    pub transformation: TransformationMatrix,
}

impl From<SubpixelSprite> for Primitive {
    fn from(sprite: SubpixelSprite) -> Self {
        Primitive::SubpixelSprite(sprite)
    }
}

#[derive(Copy, Clone, Debug)]
#[repr(C)]
#[expect(missing_docs)]
pub struct PolychromeSprite {
    pub order: DrawOrder,
    pub pad: u32,
    pub grayscale: PaddedBool32,
    pub opacity: f32,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    pub corner_radii: Corners<ScaledPixels>,
    pub tile: AtlasTile,
    pub transformation: TransformationMatrix,
}

impl From<PolychromeSprite> for Primitive {
    fn from(sprite: PolychromeSprite) -> Self {
        Primitive::PolychromeSprite(sprite)
    }
}

#[derive(Clone, Debug)]
#[allow(missing_docs)]
pub struct PaintSurface {
    pub order: DrawOrder,
    pub bounds: Bounds<ScaledPixels>,
    pub content_mask: ContentMask<ScaledPixels>,
    #[cfg(target_os = "macos")]
    pub image_buffer: core_video::pixel_buffer::CVPixelBuffer,
}

impl From<PaintSurface> for Primitive {
    fn from(surface: PaintSurface) -> Self {
        Primitive::Surface(surface)
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
#[expect(missing_docs)]
pub struct PathId(pub usize);

/// A line made up of a series of vertices and control points.
#[derive(Clone, Debug)]
#[expect(missing_docs)]
pub struct Path<P: Clone + Debug + Default + PartialEq> {
    pub id: PathId,
    pub order: DrawOrder,
    pub bounds: Bounds<P>,
    pub content_mask: ContentMask<P>,
    pub vertices: Vec<PathVertex<P>>,
    pub color: Background,
    pub transformation: TransformationMatrix,
    start: Point<P>,
    current: Point<P>,
    contour_count: usize,
}

impl Path<Pixels> {
    /// Create a new path with the given starting point.
    pub fn new(start: Point<Pixels>) -> Self {
        Self {
            id: PathId(0),
            order: DrawOrder::default(),
            vertices: Vec::new(),
            start,
            current: start,
            bounds: Bounds {
                origin: start,
                size: Default::default(),
            },
            content_mask: Default::default(),
            color: Default::default(),
            transformation: TransformationMatrix::unit(),
            contour_count: 0,
        }
    }

    /// Scale this path by the given factor.
    pub fn scale(&self, factor: f32) -> Path<ScaledPixels> {
        Path {
            id: self.id,
            order: self.order,
            bounds: self.bounds.scale(factor),
            content_mask: self.content_mask.scale(factor),
            vertices: self
                .vertices
                .iter()
                .map(|vertex| vertex.scale(factor))
                .collect(),
            start: self.start.map(|start| start.scale(factor)),
            current: self.current.scale(factor),
            contour_count: self.contour_count,
            color: self.color,
            transformation: self.transformation,
        }
    }
    /// Move the start, current point to the given point.
    pub fn move_to(&mut self, to: Point<Pixels>) {
        self.contour_count += 1;
        self.start = to;
        self.current = to;
    }

    /// Draw a straight line from the current point to the given point.
    pub fn line_to(&mut self, to: Point<Pixels>) {
        self.contour_count += 1;
        if self.contour_count > 1 {
            self.push_triangle(
                (self.start, self.current, to),
                (point(0., 1.), point(0., 1.), point(0., 1.)),
            );
        }
        self.current = to;
    }

    /// Draw a curve from the current point to the given point, using the given control point.
    pub fn curve_to(&mut self, to: Point<Pixels>, ctrl: Point<Pixels>) {
        self.contour_count += 1;
        if self.contour_count > 1 {
            self.push_triangle(
                (self.start, self.current, to),
                (point(0., 1.), point(0., 1.), point(0., 1.)),
            );
        }

        self.push_triangle(
            (self.current, ctrl, to),
            (point(0., 0.), point(0.5, 0.), point(1., 1.)),
        );
        self.current = to;
    }

    /// Push a triangle to the Path.
    pub fn push_triangle(
        &mut self,
        xy: (Point<Pixels>, Point<Pixels>, Point<Pixels>),
        st: (Point<f32>, Point<f32>, Point<f32>),
    ) {
        self.bounds = self
            .bounds
            .union(&Bounds {
                origin: xy.0,
                size: Default::default(),
            })
            .union(&Bounds {
                origin: xy.1,
                size: Default::default(),
            })
            .union(&Bounds {
                origin: xy.2,
                size: Default::default(),
            });

        self.vertices.push(PathVertex {
            xy_position: xy.0,
            st_position: st.0,
            content_mask: Default::default(),
        });
        self.vertices.push(PathVertex {
            xy_position: xy.1,
            st_position: st.1,
            content_mask: Default::default(),
        });
        self.vertices.push(PathVertex {
            xy_position: xy.2,
            st_position: st.2,
            content_mask: Default::default(),
        });
    }
}

impl<T> Path<T>
where
    T: Clone + Debug + Default + PartialEq + PartialOrd + Add<T, Output = T> + Sub<Output = T>,
{
    #[allow(unused)]
    #[expect(missing_docs)]
    pub fn clipped_bounds(&self) -> Bounds<T> {
        self.bounds.intersect(&self.content_mask.bounds)
    }
}

impl From<Path<ScaledPixels>> for Primitive {
    fn from(path: Path<ScaledPixels>) -> Self {
        Primitive::Path(path)
    }
}

#[derive(Clone, Debug)]
#[repr(C)]
#[expect(missing_docs)]
pub struct PathVertex<P: Clone + Debug + Default + PartialEq> {
    pub xy_position: Point<P>,
    pub st_position: Point<f32>,
    pub content_mask: ContentMask<P>,
}

#[expect(missing_docs)]
impl PathVertex<Pixels> {
    pub fn scale(&self, factor: f32) -> PathVertex<ScaledPixels> {
        PathVertex {
            xy_position: self.xy_position.scale(factor),
            st_position: self.st_position,
            content_mask: self.content_mask.scale(factor),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BorderStyle, ScaledPixels, TransformationMatrix, point, size};

    fn rect(x: f32, y: f32, w: f32, h: f32) -> Bounds<ScaledPixels> {
        Bounds {
            origin: point(ScaledPixels(x), ScaledPixels(y)),
            size: size(ScaledPixels(w), ScaledPixels(h)),
        }
    }

    fn mask() -> ContentMask<ScaledPixels> {
        ContentMask {
            bounds: rect(0.0, 0.0, 1000.0, 1000.0),
            corner_radii: Corners::default(),
        }
    }

    fn quad(bounds: Bounds<ScaledPixels>) -> Quad {
        Quad {
            order: 0,
            border_style: BorderStyle::default(),
            bounds,
            content_mask: mask(),
            background: Background::default(),
            border_color: Hsla::default(),
            corner_radii: Corners::default(),
            border_widths: Edges::default(),
            transformation: TransformationMatrix::unit(),
        }
    }

    fn surface(bounds: Bounds<ScaledPixels>) -> PaintSurface {
        PaintSurface {
            order: 0,
            bounds,
            content_mask: mask(),
            #[cfg(target_os = "macos")]
            image_buffer: Default::default(),
        }
    }

    /// The kinds in draw sequence, one entry per batch, with the batch length.
    fn batch_kinds(scene: &Scene) -> Vec<(PrimitiveKind, usize)> {
        scene
            .batches()
            .map(|batch| match batch {
                PrimitiveBatch::Shadows(r) => (PrimitiveKind::Shadow, r.len()),
                PrimitiveBatch::Quads(r) => (PrimitiveKind::Quad, r.len()),
                PrimitiveBatch::Paths(r) => (PrimitiveKind::Path, r.len()),
                PrimitiveBatch::Underlines(r) => (PrimitiveKind::Underline, r.len()),
                PrimitiveBatch::MonochromeSprites { range, .. } => {
                    (PrimitiveKind::MonochromeSprite, range.len())
                }
                PrimitiveBatch::SubpixelSprites { range, .. } => {
                    (PrimitiveKind::SubpixelSprite, range.len())
                }
                PrimitiveBatch::PolychromeSprites { range, .. } => {
                    (PrimitiveKind::PolychromeSprite, range.len())
                }
                PrimitiveBatch::Surfaces(r) => (PrimitiveKind::Surface, r.len()),
                PrimitiveBatch::BackdropBlurs(r) => (PrimitiveKind::BackdropBlur, r.len()),
                PrimitiveBatch::StartPathClip(_) => (PrimitiveKind::StartPathClip, 1),
                PrimitiveBatch::EndPathClip => (PrimitiveKind::EndPathClip, 1),
            })
            .collect()
    }

    /// The wall this patch removes: inside a layer every primitive shared the
    /// layer's order, so a quad painted after a surface drew under it because
    /// equal orders batch by kind and surfaces batch after quads.
    #[test]
    fn a_quad_painted_over_a_surface_inside_a_layer_draws_above_it() {
        let mut scene = Scene::default();
        let layer = rect(0.0, 0.0, 200.0, 200.0);
        scene.push_layer(layer);
        scene.insert_primitive(surface(layer));
        scene.insert_primitive(quad(rect(10.0, 10.0, 50.0, 50.0)));
        scene.pop_layer();
        scene.finish();

        assert_eq!(
            batch_kinds(&scene),
            vec![(PrimitiveKind::Surface, 1), (PrimitiveKind::Quad, 1)]
        );
    }

    /// Non-overlapping primitives inside a layer still share an order, so a
    /// list of rows costs one batch per kind, not one per row.
    #[test]
    fn non_overlapping_rows_in_a_layer_batch_by_kind() {
        let mut scene = Scene::default();
        scene.push_layer(rect(0.0, 0.0, 200.0, 400.0));
        for row in 0..10 {
            let y = row as f32 * 40.0;
            scene.insert_primitive(quad(rect(0.0, y, 200.0, 40.0)));
            scene.insert_primitive(surface(rect(4.0, y + 4.0, 32.0, 32.0)));
        }
        scene.pop_layer();
        scene.finish();

        assert_eq!(
            batch_kinds(&scene),
            vec![(PrimitiveKind::Quad, 10), (PrimitiveKind::Surface, 10)]
        );
    }

    /// A sibling painted after a layer and overlapping it draws above the
    /// layer's contents. Shifting in-layer orders by a global sequence broke
    /// this: a layer's children outran the orders of everything painted later.
    #[test]
    fn a_sibling_painted_after_a_layer_draws_above_the_layer_contents() {
        let mut scene = Scene::default();
        for i in 0..8 {
            scene.insert_primitive(quad(rect(0.0, 0.0, 100.0 + i as f32, 100.0)));
        }
        scene.push_layer(rect(0.0, 0.0, 200.0, 200.0));
        scene.insert_primitive(quad(rect(0.0, 0.0, 200.0, 200.0)));
        scene.insert_primitive(quad(rect(0.0, 0.0, 150.0, 150.0)));
        scene.insert_primitive(quad(rect(0.0, 0.0, 120.0, 120.0)));
        scene.pop_layer();
        scene.insert_primitive(surface(rect(20.0, 20.0, 60.0, 60.0)));
        scene.finish();

        let layer_max = scene.quads.iter().map(|q| q.order).max().unwrap();
        let tooltip = scene.surfaces[0].order;
        assert!(
            tooltip > layer_max,
            "tooltip order {tooltip} must exceed every layer quad order {layer_max}"
        );
    }

    /// An explicit z-index reorders within its scope regardless of kind or
    /// paint sequence: the surface at z 2 draws above the quad at z 1 that was
    /// painted after it.
    #[test]
    fn a_higher_z_index_draws_above_a_lower_one_whatever_the_kind_or_sequence() {
        let mut scene = Scene::default();
        let bounds = rect(0.0, 0.0, 100.0, 100.0);
        scene.push_z_index(2);
        scene.insert_primitive(surface(bounds));
        scene.pop_z_index();
        scene.push_z_index(1);
        scene.insert_primitive(quad(bounds));
        scene.pop_z_index();
        scene.insert_primitive(quad(rect(0.0, 0.0, 10.0, 10.0)));
        scene.finish();

        assert_eq!(
            batch_kinds(&scene),
            vec![(PrimitiveKind::Quad, 2), (PrimitiveKind::Surface, 1)]
        );
        assert!(
            scene
                .quads
                .iter()
                .all(|q| q.order < scene.surfaces[0].order)
        );
    }

    /// A negative z-index sinks below the scope's unindexed primitives, even
    /// when painted last.
    #[test]
    fn a_negative_z_index_sinks_below_the_unindexed_primitives_of_its_scope() {
        let mut scene = Scene::default();
        let bounds = rect(0.0, 0.0, 100.0, 100.0);
        scene.insert_primitive(surface(bounds));
        scene.push_z_index(-1);
        scene.insert_primitive(quad(bounds));
        scene.pop_z_index();
        scene.finish();

        assert_eq!(
            batch_kinds(&scene),
            vec![(PrimitiveKind::Quad, 1), (PrimitiveKind::Surface, 1)]
        );
    }

    /// A z-index inside a layer is scoped to that layer: it cannot lift the
    /// layer's contents above a sibling painted after the layer.
    #[test]
    fn a_z_index_inside_a_layer_does_not_escape_the_layer() {
        let mut scene = Scene::default();
        let bounds = rect(0.0, 0.0, 100.0, 100.0);
        scene.push_layer(bounds);
        scene.push_z_index(1_000);
        scene.insert_primitive(surface(bounds));
        scene.pop_z_index();
        scene.pop_layer();
        scene.insert_primitive(quad(bounds));
        scene.finish();

        assert_eq!(
            batch_kinds(&scene),
            vec![(PrimitiveKind::Surface, 1), (PrimitiveKind::Quad, 1)]
        );
    }

    /// Replaying a cached subtree derives the same orders as painting it, so a
    /// reused view and a re-rendered view sort identically.
    #[test]
    fn replay_reproduces_the_orders_of_the_original_paint() {
        let mut first = Scene::default();
        first.push_layer(rect(0.0, 0.0, 200.0, 200.0));
        first.insert_primitive(surface(rect(0.0, 0.0, 200.0, 200.0)));
        first.push_z_index(3);
        first.insert_primitive(quad(rect(10.0, 10.0, 50.0, 50.0)));
        first.pop_z_index();
        first.pop_layer();
        first.insert_primitive(quad(rect(0.0, 0.0, 20.0, 20.0)));
        let operations = first.len();

        let mut second = Scene::default();
        second.replay(0..operations, &first);

        first.finish();
        second.finish();
        let orders = |scene: &Scene| {
            (
                scene.quads.iter().map(|q| q.order).collect::<Vec<_>>(),
                scene.surfaces.iter().map(|s| s.order).collect::<Vec<_>>(),
            )
        };
        assert_eq!(orders(&first), orders(&second));
        assert_eq!(
            batch_kinds(&second),
            vec![(PrimitiveKind::Surface, 1), (PrimitiveKind::Quad, 2)]
        );
        assert_eq!(orders(&second).0, vec![1, 2]);
    }

    #[test]
    fn content_mask_intersect_preserves_and_clamps_corner_radii() {
        let outer = ContentMask {
            bounds: rect(0.0, 0.0, 100.0, 100.0),
            corner_radii: Corners::default(),
        };
        let inner = ContentMask {
            bounds: rect(10.0, 10.0, 20.0, 20.0),
            corner_radii: Corners {
                top_left: ScaledPixels(15.0),
                top_right: ScaledPixels(15.0),
                bottom_right: ScaledPixels(15.0),
                bottom_left: ScaledPixels(15.0),
            },
        };
        let intersected = outer.intersect(&inner);
        assert_eq!(intersected.bounds, rect(10.0, 10.0, 20.0, 20.0));
        // Max radius for a 20x20 rect is 10.0
        assert_eq!(intersected.corner_radii.top_left, ScaledPixels(10.0));
        assert_eq!(intersected.corner_radii.top_right, ScaledPixels(10.0));
        assert_eq!(intersected.corner_radii.bottom_right, ScaledPixels(10.0));
        assert_eq!(intersected.corner_radii.bottom_left, ScaledPixels(10.0));
    }

    #[test]
    fn path_clip_batches_produce_start_and_end_path_clip_markers() {
        let mut scene = Scene::default();
        let path = Path::new(Point::default()).scale(1.0);
        scene.push_path_clip(path);
        scene.insert_primitive(quad(rect(10.0, 10.0, 50.0, 50.0)));
        scene.pop_path_clip();
        scene.finish();

        let batches = scene.batches().collect::<Vec<_>>();
        assert_eq!(batches.len(), 3, "batches: {:?}", batches);
        match (&batches[0], &batches[1], &batches[2]) {
            (
                PrimitiveBatch::StartPathClip(_),
                PrimitiveBatch::Quads(range),
                PrimitiveBatch::EndPathClip,
            ) => {
                assert_eq!(range.len(), 1);
            }
            other => panic!("unexpected batches: {:?}", other),
        }
    }
}
