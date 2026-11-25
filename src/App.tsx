import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  UserPlus,
  Users,
  Heart,
  Link2,
  Pencil,
  Trash2,
  Search,
  ZoomIn,
  ZoomOut,
  Maximize2,
  ChevronDown,
  ChevronUp,
  X,
  ArrowUp,
  ArrowDown,
  AlertCircle,
  Check,
  RotateCcw,
  TreeDeciduous,
  Unlink,
  Share2,
  Download,
  Image as ImageIcon,
  FileJson,
  Upload,
} from 'lucide-react';

// ============================================================================
// DATA MODEL & TYPES (Future-ready for profile photo support)
// ============================================================================

export interface Person {
  id: string;
  name: string;
  /**
   * Optional profile photo URL / data URI for future implementation.
   * Version 1 renders a placeholder avatar when null/undefined.
   */
  photoUrl?: string | null;
  createdAt: number;
}

export type RelationshipType = 'parent' | 'spouse';

export interface Relationship {
  id: string;
  type: RelationshipType;
  /**
   * For 'parent': fromId is the parent, toId is the child.
   * For 'spouse': fromId and toId are partners (bidirectional).
   */
  fromId: string;
  toId: string;
  createdAt: number;
}

interface FamilyTreeState {
  people: Person[];
  relationships: Relationship[];
}

// ============================================================================
// PERSISTENCE LAYER (Safe localStorage wrapper)
// ============================================================================

const STORAGE_KEY = 'kinfolk_family_tree_v1';

function encodeTreeToHash(state: FamilyTreeState): string {
  const json = JSON.stringify(state);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

function decodeTreeFromHash(hash: string): FamilyTreeState | null {
  try {
    if (!hash.startsWith('#tree=')) return null;
    const b64 = hash.slice('#tree='.length);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json);
    if (
      parsed &&
      Array.isArray(parsed.people) &&
      Array.isArray(parsed.relationships)
    ) {
      return { people: parsed.people, relationships: parsed.relationships };
    }
  } catch {
    return null;
  }
  return null;
}

function loadTreeState(): FamilyTreeState {
  try {
    const fromHash = decodeTreeFromHash(window.location.hash);
    if (fromHash && fromHash.people.length > 0) {
      return fromHash;
    }
  } catch {
    // Ignore hash parse errors
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { people: [], relationships: [] };
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      Array.isArray(parsed.people) &&
      Array.isArray(parsed.relationships)
    ) {
      return {
        people: parsed.people,
        relationships: parsed.relationships,
      };
    }
  } catch {
    // Ignore storage read errors in restricted environments
  }
  return { people: [], relationships: [] };
}

function saveTreeState(state: FamilyTreeState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage write errors in restricted environments
  }
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ============================================================================
// GRAPH & RELATIONSHIP VALIDATION UTILITIES
// ============================================================================

function getParents(personId: string, relationships: Relationship[]): string[] {
  return relationships
    .filter((r) => r.type === 'parent' && r.toId === personId)
    .map((r) => r.fromId);
}

function getChildren(personId: string, relationships: Relationship[]): string[] {
  return relationships
    .filter((r) => r.type === 'parent' && r.fromId === personId)
    .map((r) => r.toId);
}

function getSpouses(personId: string, relationships: Relationship[]): string[] {
  const spouses: string[] = [];
  for (const r of relationships) {
    if (r.type === 'spouse') {
      if (r.fromId === personId) spouses.push(r.toId);
      else if (r.toId === personId) spouses.push(r.fromId);
    }
  }
  return spouses;
}

function isAncestor(
  potentialAncestorId: string,
  descendantId: string,
  relationships: Relationship[]
): boolean {
  const visited = new Set<string>();
  const queue = [descendantId];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (curr === potentialAncestorId) return true;
    if (visited.has(curr)) continue;
    visited.add(curr);
    const parents = getParents(curr, relationships);
    for (const p of parents) {
      if (!visited.has(p)) queue.push(p);
    }
  }
  return false;
}

function validateNewRelationship(
  type: RelationshipType,
  fromId: string,
  toId: string,
  relationships: Relationship[]
): string | null {
  if (fromId === toId) {
    return type === 'spouse'
      ? 'A person cannot be their own spouse.'
      : 'A person cannot be their own parent.';
  }

  if (type === 'spouse') {
    const duplicate = relationships.some(
      (r) =>
        r.type === 'spouse' &&
        ((r.fromId === fromId && r.toId === toId) ||
          (r.fromId === toId && r.toId === fromId))
    );
    if (duplicate) {
      return 'These two people are already connected as spouses.';
    }
    return null;
  }

  // type === 'parent': fromId is parent, toId is child
  const duplicate = relationships.some(
    (r) => r.type === 'parent' && r.fromId === fromId && r.toId === toId
  );
  if (duplicate) {
    return 'This parent-child relationship already exists.';
  }

  // Prevent circular parent-child relationship:
  // If toId is already an ancestor of fromId, adding fromId -> toId creates a cycle.
  if (isAncestor(toId, fromId, relationships)) {
    return 'This connection would create a circular parent-child relationship.';
  }

  return null;
}

function getAllDescendants(
  rootId: string,
  relationships: Relationship[]
): Set<string> {
  const result = new Set<string>();
  const queue = [...getChildren(rootId, relationships)];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (result.has(curr)) continue;
    result.add(curr);
    for (const c of getChildren(curr, relationships)) {
      if (!result.has(c)) queue.push(c);
    }
  }
  return result;
}

// ============================================================================
// GENERATION & TREE LAYOUT ENGINE
// ============================================================================

const CARD_WIDTH = 200;
const CARD_HEIGHT = 82;
const SPOUSE_GAP = 36;
const SIBLING_GAP = 42;
const COMPONENT_GAP = 90;
const GEN_HEIGHT = 172;

interface PositionedNode {
  person: Person;
  x: number;
  y: number;
  generation: number;
  hasChildren: boolean;
  hiddenDescendantCount: number;
  isCollapsed: boolean;
}

interface SpouseEdge {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  fromId: string;
  toId: string;
}

interface ParentChildEdge {
  id: string;
  parentX: number;
  parentY: number;
  childX: number;
  childY: number;
  parentIds: string[];
  childId: string;
}

interface TreeLayout {
  nodes: PositionedNode[];
  spouseEdges: SpouseEdge[];
  parentChildEdges: ParentChildEdge[];
  generations: Map<string, number>;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

function computeTreeLayout(
  people: Person[],
  relationships: Relationship[],
  collapsedIds: Set<string>
): TreeLayout {
  if (people.length === 0) {
    return {
      nodes: [],
      spouseEdges: [],
      parentChildEdges: [],
      generations: new Map(),
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    };
  }

  const personMap = new Map<string, Person>();
  people.forEach((p) => personMap.set(p.id, p));

  // 1. Determine visible people (respecting collapsed branches)
  const hiddenByCollapse = new Set<string>();
  for (const cid of collapsedIds) {
    if (!personMap.has(cid)) continue;
    const descendants = getAllDescendants(cid, relationships);
    for (const d of descendants) {
      // Hide descendant unless it also has an uncollapsed visible parent path
      const parents = getParents(d, relationships);
      const hasOtherVisibleParent = parents.some(
        (p) => p !== cid && !collapsedIds.has(p) && !hiddenByCollapse.has(p)
      );
      if (!hasOtherVisibleParent) {
        hiddenByCollapse.add(d);
      }
    }
  }
  // Iteratively ensure descendants of hidden nodes are also hidden unless reachable
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of people) {
      if (hiddenByCollapse.has(p.id)) continue;
      const parents = getParents(p.id, relationships);
      if (
        parents.length > 0 &&
        parents.every((pid) => collapsedIds.has(pid) || hiddenByCollapse.has(pid))
      ) {
        hiddenByCollapse.add(p.id);
        changed = true;
      }
    }
  }

  const visiblePeople = people.filter((p) => !hiddenByCollapse.has(p.id));
  const visibleSet = new Set(visiblePeople.map((p) => p.id));
  const visibleRels = relationships.filter(
    (r) => visibleSet.has(r.fromId) && visibleSet.has(r.toId)
  );

  // 2. Compute connected components & generation levels
  const adj = new Map<string, Array<{ id: string; delta: number }>>();
  visiblePeople.forEach((p) => adj.set(p.id, []));
  for (const r of visibleRels) {
    if (r.type === 'parent') {
      adj.get(r.fromId)?.push({ id: r.toId, delta: 1 });
      adj.get(r.toId)?.push({ id: r.fromId, delta: -1 });
    } else {
      adj.get(r.fromId)?.push({ id: r.toId, delta: 0 });
      adj.get(r.toId)?.push({ id: r.fromId, delta: 0 });
    }
  }

  const generations = new Map<string, number>();
  const components: string[][] = [];

  for (const p of visiblePeople) {
    if (generations.has(p.id)) continue;
    const comp: string[] = [];
    const queue: string[] = [p.id];
    generations.set(p.id, 0);

    while (queue.length > 0) {
      const curr = queue.shift()!;
      comp.push(curr);
      const currGen = generations.get(curr)!;
      for (const edge of adj.get(curr) || []) {
        if (!generations.has(edge.id)) {
          generations.set(edge.id, currGen + edge.delta);
          queue.push(edge.id);
        }
      }
    }

    // Normalize component generations so minimum is 0
    let minGen = Infinity;
    for (const id of comp) {
      minGen = Math.min(minGen, generations.get(id)!);
    }
    for (const id of comp) {
      generations.set(id, generations.get(id)! - minGen);
    }
    components.push(comp);
  }

  // 3. Build Family Units (couple or single) & hierarchical subtree layout per component
  const positions = new Map<string, { x: number; y: number }>();

  interface FamilyUnit {
    id: string;
    memberIds: string[];
    gen: number;
    childUnits: FamilyUnit[];
    width: number;
    subtreeWidth: number;
    x: number;
  }

  let currentComponentOffsetX = 0;

  for (const comp of components) {
    const compSet = new Set(comp);
    // Group spouses in the same generation into units
    const personToUnit = new Map<string, FamilyUnit>();
    const units: FamilyUnit[] = [];

    // Sort comp by generation then createdAt for deterministic ordering
    const sortedComp = [...comp].sort((a, b) => {
      const ga = generations.get(a)!;
      const gb = generations.get(b)!;
      if (ga !== gb) return ga - gb;
      return (personMap.get(a)?.createdAt || 0) - (personMap.get(b)?.createdAt || 0);
    });

    for (const pid of sortedComp) {
      if (personToUnit.has(pid)) continue;
      const gen = generations.get(pid)!;
      const spouses = getSpouses(pid, visibleRels).filter(
        (sid) => compSet.has(sid) && generations.get(sid) === gen && !personToUnit.has(sid)
      );
      const members = [pid, ...spouses];
      const unitWidth =
        members.length * CARD_WIDTH + (members.length - 1) * SPOUSE_GAP;

      const unit: FamilyUnit = {
        id: `unit_${members.join('_')}`,
        memberIds: members,
        gen,
        childUnits: [],
        width: unitWidth,
        subtreeWidth: unitWidth,
        x: 0,
      };
      units.push(unit);
      members.forEach((m) => personToUnit.set(m, unit));
    }

    // Attach each child unit to one primary parent unit (forming a clean forest)
    const hasParentUnit = new Set<string>();
    for (const unit of units) {
      // Find parents of any member in this unit; prefer the first member who has parents
      let parentUnit: FamilyUnit | undefined;
      for (const m of unit.memberIds) {
        const parents = getParents(m, visibleRels);
        if (parents.length > 0) {
          parentUnit = personToUnit.get(parents[0]);
          if (parentUnit && parentUnit.id !== unit.id) break;
        }
      }
      if (parentUnit && !hasParentUnit.has(unit.id)) {
        parentUnit.childUnits.push(unit);
        hasParentUnit.add(unit.id);
      }
    }

    const rootUnits = units.filter((u) => !hasParentUnit.has(u.id));

    // Bottom-up subtree width calculation (with cycle guard)
    const visitedWidth = new Set<string>();
    function calcSubtreeWidth(u: FamilyUnit): number {
      if (visitedWidth.has(u.id)) return u.width;
      visitedWidth.add(u.id);
      if (u.childUnits.length === 0) {
        u.subtreeWidth = u.width;
        return u.subtreeWidth;
      }
      let childrenTotal = 0;
      u.childUnits.forEach((cu, idx) => {
        childrenTotal += calcSubtreeWidth(cu);
        if (idx > 0) childrenTotal += SIBLING_GAP;
      });
      u.subtreeWidth = Math.max(u.width, childrenTotal);
      return u.subtreeWidth;
    }

    // Top-down X assignment
    const visitedPlace = new Set<string>();
    function placeUnit(u: FamilyUnit, leftX: number) {
      if (visitedPlace.has(u.id)) return;
      visitedPlace.add(u.id);

      u.x = leftX + (u.subtreeWidth - u.width) / 2;

      // Place each member inside this unit
      u.memberIds.forEach((mid, idx) => {
        positions.set(mid, {
          x: u.x + idx * (CARD_WIDTH + SPOUSE_GAP),
          y: u.gen * GEN_HEIGHT,
        });
      });

      if (u.childUnits.length > 0) {
        let childrenTotal = 0;
        u.childUnits.forEach((cu, idx) => {
          childrenTotal += cu.subtreeWidth;
          if (idx > 0) childrenTotal += SIBLING_GAP;
        });
        let childLeft =
          leftX + Math.max(0, (u.subtreeWidth - childrenTotal) / 2);
        for (const cu of u.childUnits) {
          placeUnit(cu, childLeft);
          childLeft += cu.subtreeWidth + SIBLING_GAP;
        }
      }
    }

    let compLeft = currentComponentOffsetX;
    for (const ru of rootUnits) {
      calcSubtreeWidth(ru);
      placeUnit(ru, compLeft);
      compLeft += ru.subtreeWidth + SIBLING_GAP;
    }

    // Per-generation overlap resolution inside component
    const byGen = new Map<number, string[]>();
    for (const id of comp) {
      const g = generations.get(id)!;
      if (!byGen.has(g)) byGen.set(g, []);
      byGen.get(g)!.push(id);
    }
    for (const [, ids] of byGen) {
      ids.sort((a, b) => (positions.get(a)!.x) - (positions.get(b)!.x));
      for (let i = 1; i < ids.length; i++) {
        const prevPos = positions.get(ids[i - 1])!;
        const currPos = positions.get(ids[i])!;
        const minAllowed = prevPos.x + CARD_WIDTH + SPOUSE_GAP;
        if (currPos.x < minAllowed) {
          currPos.x = minAllowed;
        }
      }
    }

    // Compute component max X to offset next component cleanly
    let maxCompX = currentComponentOffsetX;
    for (const id of comp) {
      const pos = positions.get(id)!;
      maxCompX = Math.max(maxCompX, pos.x + CARD_WIDTH);
    }
    currentComponentOffsetX = maxCompX + COMPONENT_GAP;
  }

  // 4. Build PositionedNode list
  const nodes: PositionedNode[] = visiblePeople.map((person) => {
    const pos = positions.get(person.id) || { x: 0, y: 0 };
    const allChildren = getChildren(person.id, relationships);
    const isCollapsed = collapsedIds.has(person.id);
    const hiddenCount = isCollapsed
      ? getAllDescendants(person.id, relationships).size
      : 0;

    return {
      person,
      x: pos.x,
      y: pos.y,
      generation: generations.get(person.id) || 0,
      hasChildren: allChildren.length > 0,
      hiddenDescendantCount: hiddenCount,
      isCollapsed,
    };
  });

  // 5. Build Spouse Edges
  const spouseEdges: SpouseEdge[] = [];
  const seenSpousePairs = new Set<string>();
  for (const r of visibleRels) {
    if (r.type !== 'spouse') continue;
    const key = [r.fromId, r.toId].sort().join('::');
    if (seenSpousePairs.has(key)) continue;
    seenSpousePairs.add(key);

    const p1 = positions.get(r.fromId);
    const p2 = positions.get(r.toId);
    if (!p1 || !p2) continue;

    const left = p1.x <= p2.x ? p1 : p2;
    const right = p1.x <= p2.x ? p2 : p1;

    spouseEdges.push({
      id: r.id,
      x1: left.x + CARD_WIDTH,
      y1: left.y + CARD_HEIGHT / 2,
      x2: right.x,
      y2: right.y + CARD_HEIGHT / 2,
      fromId: r.fromId,
      toId: r.toId,
    });
  }

  // 6. Build Parent-Child Edges (grouping shared parents when they are spouses)
  const parentChildEdges: ParentChildEdge[] = [];
  for (const child of visiblePeople) {
    const parents = getParents(child.id, visibleRels);
    if (parents.length === 0) continue;

    const childPos = positions.get(child.id);
    if (!childPos) continue;
    const childX = childPos.x + CARD_WIDTH / 2;
    const childY = childPos.y;

    // Group parents that are spouses of each other so the line drops from their midpoint
    const handledParents = new Set<string>();
    for (const pid of parents) {
      if (handledParents.has(pid)) continue;
      const pPos = positions.get(pid);
      if (!pPos) continue;

      const coParentSpouse = parents.find(
        (otherId) =>
          otherId !== pid &&
          !handledParents.has(otherId) &&
          visibleRels.some(
            (r) =>
              r.type === 'spouse' &&
              ((r.fromId === pid && r.toId === otherId) ||
                (r.fromId === otherId && r.toId === pid))
          )
      );

      if (coParentSpouse) {
        const sPos = positions.get(coParentSpouse)!;
        handledParents.add(pid);
        handledParents.add(coParentSpouse);

        const leftX = Math.min(pPos.x, sPos.x) + CARD_WIDTH;
        const rightX = Math.max(pPos.x, sPos.x);
        const midX = (leftX + rightX) / 2;
        const midY = pPos.y + CARD_HEIGHT / 2;

        parentChildEdges.push({
          id: `pc_${pid}_${coParentSpouse}_${child.id}`,
          parentX: midX,
          parentY: midY,
          childX,
          childY,
          parentIds: [pid, coParentSpouse],
          childId: child.id,
        });
      } else {
        handledParents.add(pid);
        parentChildEdges.push({
          id: `pc_${pid}_${child.id}`,
          parentX: pPos.x + CARD_WIDTH / 2,
          parentY: pPos.y + CARD_HEIGHT,
          childX,
          childY,
          parentIds: [pid],
          childId: child.id,
        });
      }
    }
  }

  // 7. Compute Bounds
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x + CARD_WIDTH);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y + CARD_HEIGHT);
  }

  return {
    nodes,
    spouseEdges,
    parentChildEdges,
    generations,
    bounds: {
      minX: isFinite(minX) ? minX : 0,
      maxX: isFinite(maxX) ? maxX : 0,
      minY: isFinite(minY) ? minY : 0,
      maxY: isFinite(maxY) ? maxY : 0,
    },
  };
}

// ============================================================================
// GENERATION COLOR PALETTE (Subtle, warm, distinguishable tiers)
// ============================================================================

const GEN_STYLES = [
  {
    cardBg: 'bg-amber-50/90',
    border: 'border-amber-200/90',
    selectedBorder: 'border-amber-500 ring-2 ring-amber-400/40',
    avatarBg: 'bg-amber-100 text-amber-800',
    badge: 'bg-amber-100/80 text-amber-800',
    accentBar: 'bg-amber-400',
  },
  {
    cardBg: 'bg-emerald-50/85',
    border: 'border-emerald-200/90',
    selectedBorder: 'border-emerald-500 ring-2 ring-emerald-400/40',
    avatarBg: 'bg-emerald-100 text-emerald-800',
    badge: 'bg-emerald-100/80 text-emerald-800',
    accentBar: 'bg-emerald-400',
  },
  {
    cardBg: 'bg-sky-50/85',
    border: 'border-sky-200/90',
    selectedBorder: 'border-sky-500 ring-2 ring-sky-400/40',
    avatarBg: 'bg-sky-100 text-sky-800',
    badge: 'bg-sky-100/80 text-sky-800',
    accentBar: 'bg-sky-400',
  },
  {
    cardBg: 'bg-violet-50/85',
    border: 'border-violet-200/90',
    selectedBorder: 'border-violet-500 ring-2 ring-violet-400/40',
    avatarBg: 'bg-violet-100 text-violet-800',
    badge: 'bg-violet-100/80 text-violet-800',
    accentBar: 'bg-violet-400',
  },
  {
    cardBg: 'bg-rose-50/85',
    border: 'border-rose-200/90',
    selectedBorder: 'border-rose-500 ring-2 ring-rose-400/40',
    avatarBg: 'bg-rose-100 text-rose-800',
    badge: 'bg-rose-100/80 text-rose-800',
    accentBar: 'bg-rose-400',
  },
];

function getGenStyle(gen: number) {
  return GEN_STYLES[Math.abs(gen) % GEN_STYLES.length];
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ============================================================================
// AVATAR COMPONENT (Prepared for future photo upload/replace/remove)
// ============================================================================

function PersonAvatar({
  person,
  generation,
  size = 'md',
}: {
  person: Person;
  generation: number;
  size?: 'sm' | 'md' | 'lg';
}) {
  const style = getGenStyle(generation);
  const sizeClass =
    size === 'sm'
      ? 'w-8 h-8 text-xs'
      : size === 'lg'
        ? 'w-12 h-12 text-base'
        : 'w-10 h-10 text-sm';

  if (person.photoUrl) {
    return (
      <img
        src={person.photoUrl}
        alt={person.name}
        className={`${sizeClass} rounded-full object-cover border border-white shadow-sm shrink-0`}
      />
    );
  }

  return (
    <div
      className={`${sizeClass} ${style.avatarBg} rounded-full flex items-center justify-center font-semibold tracking-tight border border-white shadow-sm shrink-0 select-none`}
      aria-hidden="true"
    >
      {getInitials(person.name)}
    </div>
  );
}

// ============================================================================
// MAIN APPLICATION COMPONENT
// ============================================================================

type ModalState =
  | { type: 'none' }
  | {
      type: 'add_person';
      mode: 'independent' | 'parent' | 'child' | 'spouse';
      targetPersonId?: string;
    }
  | { type: 'connect_existing'; targetPersonId: string }
  | { type: 'rename'; targetPersonId: string }
  | { type: 'delete_confirm'; targetPersonId: string }
  | { type: 'reset_confirm' };

export default function App() {
  // Core persistent state
  const [treeState, setTreeState] = useState<FamilyTreeState>(() => loadTreeState());

  // UI & Viewport state
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [modal, setModal] = useState<ModalState>({ type: 'none' });
  const [toast, setToast] = useState<{ message: string; kind: 'info' | 'error' } | null>(null);

  // Search & Export/Share menu state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Pan & Zoom state
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStartRef = useRef<{
    dist: number;
    zoom: number;
    panX: number;
    panY: number;
    midX: number;
    midY: number;
  } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const didInitialFitRef = useRef(false);

  // Form states for modals
  const [nameInput, setNameInput] = useState('');
  const [onboardingName, setOnboardingName] = useState('');
  const [alsoConnectSpouse, setAlsoConnectSpouse] = useState(true);
  const [connectOtherId, setConnectOtherId] = useState('');
  const [connectDirection, setConnectDirection] = useState<
    'other_is_parent' | 'other_is_child' | 'spouse'
  >('other_is_parent');
  const [formError, setFormError] = useState<string | null>(null);

  // Persist on every state change
  useEffect(() => {
    saveTreeState(treeState);
  }, [treeState]);

  // Auto-hide toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const showToast = useCallback((message: string, kind: 'info' | 'error' = 'info') => {
    setToast({ message, kind });
  }, []);

  // Compute layout
  const layout = useMemo(
    () => computeTreeLayout(treeState.people, treeState.relationships, collapsedIds),
    [treeState.people, treeState.relationships, collapsedIds]
  );

  const personMap = useMemo(() => {
    const m = new Map<string, Person>();
    treeState.people.forEach((p) => m.set(p.id, p));
    return m;
  }, [treeState.people]);

  const selectedPerson = selectedPersonId ? personMap.get(selectedPersonId) || null : null;

  // Fit entire tree to screen
  const fitToScreen = useCallback(() => {
    const container = canvasRef.current;
    if (!container || layout.nodes.length === 0) {
      setPan({ x: 0, y: 0 });
      setZoom(1);
      return;
    }

    const rect = container.getBoundingClientRect();
    const padding = 80;
    const treeW = Math.max(CARD_WIDTH, layout.bounds.maxX - layout.bounds.minX);
    const treeH = Math.max(CARD_HEIGHT, layout.bounds.maxY - layout.bounds.minY);

    const scaleX = (rect.width - padding * 2) / treeW;
    const scaleY = (rect.height - padding * 2) / treeH;
    const nextZoom = Math.min(1.15, Math.max(0.35, Math.min(scaleX, scaleY)));

    const centerX = (layout.bounds.minX + layout.bounds.maxX) / 2;
    const centerY = (layout.bounds.minY + layout.bounds.maxY) / 2;

    setZoom(nextZoom);
    setPan({
      x: rect.width / 2 - centerX * nextZoom,
      y: rect.height / 2 - centerY * nextZoom,
    });
  }, [layout.bounds, layout.nodes.length]);

  // Center on a specific node
  const focusNode = useCallback(
    (personId: string) => {
      const container = canvasRef.current;
      const node = layout.nodes.find((n) => n.person.id === personId);
      if (!container || !node) return;
      const rect = container.getBoundingClientRect();
      const targetZoom = Math.max(zoom, 0.95);
      const cx = node.x + CARD_WIDTH / 2;
      const cy = node.y + CARD_HEIGHT / 2;
      setZoom(targetZoom);
      setPan({
        x: rect.width / 2 - cx * targetZoom,
        y: rect.height / 2 - cy * targetZoom,
      });
    },
    [layout.nodes, zoom]
  );

  // Zoom centered on the viewport
  const zoomBy = useCallback(
    (factor: number) => {
      const container = canvasRef.current;
      const nextZoom = Math.min(2, Math.max(0.25, zoom * factor));
      if (!container) {
        setZoom(nextZoom);
        return;
      }
      const rect = container.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const ratio = nextZoom / zoom;
      setZoom(nextZoom);
      setPan((p) => ({
        x: cx - (cx - p.x) * ratio,
        y: cy - (cy - p.y) * ratio,
      }));
    },
    [zoom]
  );

  // Keyboard shortcuts for zoom (+ / - / 0)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomBy(1.15);
      } else if (e.key === '-') {
        e.preventDefault();
        zoomBy(1 / 1.15);
      } else if (e.key === '0') {
        e.preventDefault();
        fitToScreen();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [zoomBy, fitToScreen]);

  // Export tree as crisp 2x PNG image using Canvas 2D
  const handleExportPng = useCallback(() => {
    setShareMenuOpen(false);
    if (layout.nodes.length === 0) return;

    const pad = 64;
    const width = Math.max(480, layout.bounds.maxX - layout.bounds.minX + pad * 2);
    const height = Math.max(320, layout.bounds.maxY - layout.bounds.minY + pad * 2);
    const dpr = 2;

    const canvas = document.createElement('canvas');
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#FAF7F2';
    ctx.fillRect(0, 0, width, height);

    const ox = -layout.bounds.minX + pad;
    const oy = -layout.bounds.minY + pad;

    // Parent-child lines
    ctx.strokeStyle = '#94A3B8';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const edge of layout.parentChildEdges) {
      const midY = (edge.parentY + edge.childY) / 2;
      ctx.beginPath();
      ctx.moveTo(edge.parentX + ox, edge.parentY + oy);
      ctx.lineTo(edge.parentX + ox, midY + oy);
      ctx.lineTo(edge.childX + ox, midY + oy);
      ctx.lineTo(edge.childX + ox, edge.childY + oy);
      ctx.stroke();

      ctx.fillStyle = '#94A3B8';
      ctx.beginPath();
      ctx.arc(edge.childX + ox, edge.childY + oy, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Spouse lines
    for (const edge of layout.spouseEdges) {
      ctx.save();
      ctx.strokeStyle = '#FB7185';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(edge.x1 + ox, edge.y1 + oy);
      ctx.lineTo(edge.x2 + ox, edge.y2 + oy);
      ctx.stroke();
      ctx.restore();
    }

    const genColors = [
      { bg: '#FFFBEB', border: '#FDE68A', accent: '#FBBF24', avatar: '#FEF3C7', text: '#92400E' },
      { bg: '#ECFDF5', border: '#A7F3D0', accent: '#34D399', avatar: '#D1FAE5', text: '#065F46' },
      { bg: '#EFF6FF', border: '#BFDBFE', accent: '#60A5FA', avatar: '#DBEAFE', text: '#1E40AF' },
      { bg: '#F5F3FF', border: '#DDD6FE', accent: '#A78BFA', avatar: '#EDE9FE', text: '#5B21B6' },
      { bg: '#FFF1F2', border: '#FECDD3', accent: '#FB7185', avatar: '#FFE4E6', text: '#9F1239' },
    ];

    const drawRoundRect = (x: number, y: number, w: number, h: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    };

    for (const node of layout.nodes) {
      const palette = genColors[Math.abs(node.generation) % genColors.length];
      const nx = node.x + ox;
      const ny = node.y + oy;

      ctx.save();
      ctx.shadowColor = 'rgba(28, 25, 23, 0.08)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 3;
      drawRoundRect(nx, ny, CARD_WIDTH, CARD_HEIGHT, 16);
      ctx.fillStyle = palette.bg;
      ctx.fill();
      ctx.restore();

      drawRoundRect(nx, ny, CARD_WIDTH, CARD_HEIGHT, 16);
      ctx.strokeStyle = palette.border;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Avatar circle
      const ax = nx + 34;
      const ay = ny + CARD_HEIGHT / 2;
      ctx.fillStyle = palette.avatar;
      ctx.beginPath();
      ctx.arc(ax, ay, 20, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = palette.text;
      ctx.font = '600 13px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(getInitials(node.person.name), ax, ay);

      // Name & Gen label
      ctx.fillStyle = '#1C1917';
      ctx.font = '600 14px Inter, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const maxTextW = CARD_WIDTH - 76;
      let displayName = node.person.name;
      while (ctx.measureText(displayName).width > maxTextW && displayName.length > 3) {
        displayName = displayName.slice(0, -2) + '…';
      }
      ctx.fillText(displayName, nx + 64, ny + CARD_HEIGHT / 2 - 9);

      ctx.fillStyle = palette.text;
      ctx.font = '500 10px Inter, system-ui, sans-serif';
      ctx.fillText(`Gen ${node.generation + 1}`, nx + 64, ny + CARD_HEIGHT / 2 + 12);
    }

    const link = document.createElement('a');
    link.download = 'family-tree.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
    showToast('Downloaded family-tree.png');
  }, [layout, showToast]);

  // Export JSON backup
  const handleExportJson = useCallback(() => {
    setShareMenuOpen(false);
    const blob = new Blob([JSON.stringify(treeState, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = 'family-tree.json';
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
    showToast('Exported family-tree.json');
  }, [treeState, showToast]);

  // Import JSON backup
  const handleImportJson = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result || ''));
          if (
            parsed &&
            Array.isArray(parsed.people) &&
            Array.isArray(parsed.relationships)
          ) {
            setTreeState({
              people: parsed.people,
              relationships: parsed.relationships,
            });
            setSelectedPersonId(null);
            setCollapsedIds(new Set());
            didInitialFitRef.current = false;
            showToast(`Imported ${parsed.people.length} family members.`);
          } else {
            showToast('Invalid family tree file.', 'error');
          }
        } catch {
          showToast('Could not read JSON file.', 'error');
        }
      };
      reader.readAsText(file);
    },
    [showToast]
  );

  // Copy shareable link with encoded tree state in URL hash
  const handleCopyShareLink = useCallback(() => {
    setShareMenuOpen(false);
    try {
      const encoded = encodeTreeToHash(treeState);
      const baseUrl = window.location.href.split('#')[0];
      const shareUrl = `${baseUrl}#tree=${encoded}`;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(shareUrl)
          .then(() => showToast('Shareable link copied to clipboard!'))
          .catch(() => {
            const ta = document.createElement('textarea');
            ta.value = shareUrl;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            showToast('Shareable link copied!');
          });
      } else {
        const ta = document.createElement('textarea');
        ta.value = shareUrl;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('Shareable link copied!');
      }
    } catch {
      showToast('Could not create share link.', 'error');
    }
  }, [treeState, showToast]);

  // Initial fit on first load when data exists
  useEffect(() => {
    if (!didInitialFitRef.current && layout.nodes.length > 0 && canvasRef.current) {
      didInitialFitRef.current = true;
      fitToScreen();
    }
  }, [layout.nodes.length, fitToScreen]);

  // ============================================================================
  // DATA MUTATION HANDLERS (Modular, pure state updates)
  // ============================================================================

  const handleCreateFirstPerson = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = onboardingName.trim();
    if (!trimmed) return;
    const newPerson: Person = {
      id: generateId('person'),
      name: trimmed,
      photoUrl: null,
      createdAt: Date.now(),
    };
    setTreeState({ people: [newPerson], relationships: [] });
    setOnboardingName('');
    setSelectedPersonId(newPerson.id);
    didInitialFitRef.current = false;
    showToast(`Added ${trimmed} to your family tree.`);
  };

  const openAddModal = (
    mode: 'independent' | 'parent' | 'child' | 'spouse',
    targetPersonId?: string
  ) => {
    setNameInput('');
    setFormError(null);
    setAlsoConnectSpouse(true);
    setModal({ type: 'add_person', mode, targetPersonId });
  };

  const handleAddPersonSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (modal.type !== 'add_person') return;
    const trimmed = nameInput.trim();
    if (!trimmed) {
      setFormError('Please enter a name.');
      return;
    }

    const newPerson: Person = {
      id: generateId('person'),
      name: trimmed,
      photoUrl: null,
      createdAt: Date.now(),
    };

    const newRelationships: Relationship[] = [];
    const targetId = modal.targetPersonId;

    if (modal.mode === 'parent' && targetId) {
      newRelationships.push({
        id: generateId('rel'),
        type: 'parent',
        fromId: newPerson.id,
        toId: targetId,
        createdAt: Date.now(),
      });
    } else if (modal.mode === 'child' && targetId) {
      newRelationships.push({
        id: generateId('rel'),
        type: 'parent',
        fromId: targetId,
        toId: newPerson.id,
        createdAt: Date.now(),
      });
      if (alsoConnectSpouse) {
        const spouses = getSpouses(targetId, treeState.relationships);
        if (spouses.length === 1) {
          newRelationships.push({
            id: generateId('rel'),
            type: 'parent',
            fromId: spouses[0],
            toId: newPerson.id,
            createdAt: Date.now() + 1,
          });
        }
      }
      // Ensure branch is expanded if user adds a child
      setCollapsedIds((prev) => {
        if (!prev.has(targetId)) return prev;
        const next = new Set(prev);
        next.delete(targetId);
        return next;
      });
    } else if (modal.mode === 'spouse' && targetId) {
      newRelationships.push({
        id: generateId('rel'),
        type: 'spouse',
        fromId: targetId,
        toId: newPerson.id,
        createdAt: Date.now(),
      });
    }

    setTreeState((prev) => ({
      people: [...prev.people, newPerson],
      relationships: [...prev.relationships, ...newRelationships],
    }));

    setModal({ type: 'none' });
    setSelectedPersonId(newPerson.id);
    showToast(`Added ${trimmed}.`);
  };

  const openConnectExistingModal = (targetPersonId: string) => {
    const others = treeState.people.filter((p) => p.id !== targetPersonId);
    setConnectOtherId(others[0]?.id || '');
    setConnectDirection('other_is_parent');
    setFormError(null);
    setModal({ type: 'connect_existing', targetPersonId });
  };

  const handleConnectExistingSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (modal.type !== 'connect_existing') return;
    if (!connectOtherId) {
      setFormError('Please select a person to connect.');
      return;
    }

    const targetId = modal.targetPersonId;
    let relType: RelationshipType = 'parent';
    let fromId = connectOtherId;
    let toId = targetId;

    if (connectDirection === 'other_is_parent') {
      relType = 'parent';
      fromId = connectOtherId;
      toId = targetId;
    } else if (connectDirection === 'other_is_child') {
      relType = 'parent';
      fromId = targetId;
      toId = connectOtherId;
    } else {
      relType = 'spouse';
      fromId = targetId;
      toId = connectOtherId;
    }

    const error = validateNewRelationship(
      relType,
      fromId,
      toId,
      treeState.relationships
    );
    if (error) {
      setFormError(error);
      return;
    }

    const newRel: Relationship = {
      id: generateId('rel'),
      type: relType,
      fromId,
      toId,
      createdAt: Date.now(),
    };

    setTreeState((prev) => ({
      ...prev,
      relationships: [...prev.relationships, newRel],
    }));
    setModal({ type: 'none' });
    showToast('Relationship connected.');
  };

  const openRenameModal = (targetPersonId: string) => {
    const p = personMap.get(targetPersonId);
    if (!p) return;
    setNameInput(p.name);
    setFormError(null);
    setModal({ type: 'rename', targetPersonId });
  };

  const handleRenameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (modal.type !== 'rename') return;
    const trimmed = nameInput.trim();
    if (!trimmed) {
      setFormError('Name cannot be empty.');
      return;
    }
    setTreeState((prev) => ({
      ...prev,
      people: prev.people.map((p) =>
        p.id === modal.targetPersonId ? { ...p, name: trimmed } : p
      ),
    }));
    setModal({ type: 'none' });
    showToast(`Renamed to ${trimmed}.`);
  };

  const handleDeletePerson = (targetPersonId: string) => {
    const person = personMap.get(targetPersonId);
    setTreeState((prev) => ({
      people: prev.people.filter((p) => p.id !== targetPersonId),
      relationships: prev.relationships.filter(
        (r) => r.fromId !== targetPersonId && r.toId !== targetPersonId
      ),
    }));
    if (selectedPersonId === targetPersonId) {
      setSelectedPersonId(null);
    }
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      next.delete(targetPersonId);
      return next;
    });
    setModal({ type: 'none' });
    if (person) showToast(`Removed ${person.name}.`);
  };

  const handleRemoveRelationship = (relId: string) => {
    setTreeState((prev) => ({
      ...prev,
      relationships: prev.relationships.filter((r) => r.id !== relId),
    }));
    showToast('Connection removed.');
  };

  const handleResetTree = () => {
    setTreeState({ people: [], relationships: [] });
    setSelectedPersonId(null);
    setCollapsedIds(new Set());
    setPan({ x: 0, y: 0 });
    setZoom(1);
    didInitialFitRef.current = false;
    setModal({ type: 'none' });
    showToast('Family tree cleared.');
  };

  const toggleCollapse = (personId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  };

  // ============================================================================
  // PAN & ZOOM INTERACTION HANDLERS
  // ============================================================================

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-person-node="true"]')) return;
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointersRef.current.size === 2) {
      const pts = Array.from(activePointersRef.current.values());
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const rect = canvasRef.current?.getBoundingClientRect();
      const midX = (pts[0].x + pts[1].x) / 2 - (rect?.left || 0);
      const midY = (pts[0].y + pts[1].y) / 2 - (rect?.top || 0);
      pinchStartRef.current = {
        dist,
        zoom,
        panX: pan.x,
        panY: pan.y,
        midX,
        midY,
      };
      panStartRef.current = null;
      setIsPanning(false);
      return;
    }

    if (activePointersRef.current.size === 1) {
      setIsPanning(true);
      panStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        panX: pan.x,
        panY: pan.y,
      };
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointersRef.current.has(e.pointerId)) {
      activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    if (activePointersRef.current.size === 2 && pinchStartRef.current) {
      const pts = Array.from(activePointersRef.current.values());
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      if (pinchStartRef.current.dist > 0) {
        const scale = dist / pinchStartRef.current.dist;
        const nextZoom = Math.min(2, Math.max(0.25, pinchStartRef.current.zoom * scale));
        const ratio = nextZoom / pinchStartRef.current.zoom;
        setZoom(nextZoom);
        setPan({
          x: pinchStartRef.current.midX - (pinchStartRef.current.midX - pinchStartRef.current.panX) * ratio,
          y: pinchStartRef.current.midY - (pinchStartRef.current.midY - pinchStartRef.current.panY) * ratio,
        });
      }
      return;
    }

    if (!isPanning || !panStartRef.current) return;
    const dx = e.clientX - panStartRef.current.x;
    const dy = e.clientY - panStartRef.current.y;
    setPan({
      x: panStartRef.current.panX + dx,
      y: panStartRef.current.panY + dy,
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(e.pointerId);
    if (activePointersRef.current.size < 2) {
      pinchStartRef.current = null;
    }
    if (activePointersRef.current.size === 0) {
      setIsPanning(false);
      panStartRef.current = null;
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (treeState.people.length === 0) return;
    const container = canvasRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const factor = e.deltaY < 0 ? 1.09 : 0.92;
    const nextZoom = Math.min(2, Math.max(0.25, zoom * factor));
    const scaleRatio = nextZoom / zoom;

    setZoom(nextZoom);
    setPan({
      x: mouseX - (mouseX - pan.x) * scaleRatio,
      y: mouseY - (mouseY - pan.y) * scaleRatio,
    });
  };

  // Search results
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return treeState.people.filter((p) => p.name.toLowerCase().includes(q));
  }, [searchQuery, treeState.people]);

  // Selected person's direct relationships for the detail menu
  const selectedRelations = useMemo(() => {
    if (!selectedPerson) return { parents: [], spouses: [], children: [] };
    const pid = selectedPerson.id;
    const parents = treeState.relationships
      .filter((r) => r.type === 'parent' && r.toId === pid)
      .map((r) => ({ relId: r.id, person: personMap.get(r.fromId) }))
      .filter((item): item is { relId: string; person: Person } => Boolean(item.person));

    const children = treeState.relationships
      .filter((r) => r.type === 'parent' && r.fromId === pid)
      .map((r) => ({ relId: r.id, person: personMap.get(r.toId) }))
      .filter((item): item is { relId: string; person: Person } => Boolean(item.person));

    const spouses = treeState.relationships
      .filter((r) => r.type === 'spouse' && (r.fromId === pid || r.toId === pid))
      .map((r) => ({
        relId: r.id,
        person: personMap.get(r.fromId === pid ? r.toId : r.fromId),
      }))
      .filter((item): item is { relId: string; person: Person } => Boolean(item.person));

    return { parents, spouses, children };
  }, [selectedPerson, treeState.relationships, personMap]);

  // SVG bounding box for edges
  const svgBounds = useMemo(() => {
    const pad = 400;
    return {
      minX: layout.bounds.minX - pad,
      minY: layout.bounds.minY - pad,
      width: Math.max(1200, layout.bounds.maxX - layout.bounds.minX + pad * 2),
      height: Math.max(1000, layout.bounds.maxY - layout.bounds.minY + pad * 2),
    };
  }, [layout.bounds]);

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div
      className="h-screen w-screen overflow-hidden flex flex-col select-none font-sans text-stone-800"
      style={{
        backgroundColor: '#FAF7F2',
        fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      }}
    >
      {/* TOP BAR */}
      <header className="relative z-30 flex items-center justify-between gap-2 px-3 sm:px-5 py-2.5 bg-white/85 backdrop-blur-md border-b border-stone-200/80 shadow-xs">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
            <TreeDeciduous className="w-4.5 h-4.5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm sm:text-base font-semibold tracking-tight text-stone-900 truncate">
              Family Tree
            </h1>
          </div>
          {treeState.people.length > 0 && (
            <span className="hidden md:inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-stone-100 text-stone-600">
              {treeState.people.length}{' '}
              {treeState.people.length === 1 ? 'person' : 'people'} ·{' '}
              {treeState.relationships.length}{' '}
              {treeState.relationships.length === 1 ? 'link' : 'links'}
            </span>
          )}
        </div>

        {/* Search + Actions */}
        <div className="flex items-center gap-2">
          {treeState.people.length > 0 && (
            <div className="relative">
              <div className="flex items-center bg-stone-100/90 hover:bg-stone-100 focus-within:bg-white focus-within:ring-2 focus-within:ring-amber-400/50 rounded-xl px-2.5 py-1.5 border border-stone-200/70 transition-all">
                <Search className="w-4 h-4 text-stone-400 shrink-0" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setSearchOpen(true);
                  }}
                  onFocus={() => setSearchOpen(true)}
                  placeholder="Search member..."
                  className="bg-transparent border-none outline-none text-xs sm:text-sm text-stone-800 placeholder:text-stone-400 pl-2 w-28 sm:w-44"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setSearchOpen(false);
                    }}
                    className="text-stone-400 hover:text-stone-600 p-0.5"
                    aria-label="Clear search"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {searchOpen && searchQuery.trim() !== '' && (
                <div className="absolute right-0 mt-1.5 w-60 bg-white rounded-xl shadow-lg border border-stone-200/90 py-1.5 z-50 max-h-60 overflow-y-auto">
                  {searchResults.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-stone-500">
                      No matching family member
                    </div>
                  ) : (
                    searchResults.map((p) => {
                      const gen = layout.generations.get(p.id) ?? 0;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            setSelectedPersonId(p.id);
                            focusNode(p.id);
                            setSearchOpen(false);
                          }}
                          className="w-full px-3 py-2 flex items-center gap-2.5 hover:bg-amber-50/70 text-left transition-colors"
                        >
                          <PersonAvatar person={p} generation={gen} size="sm" />
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-stone-800 truncate">
                              {p.name}
                            </div>
                            <div className="text-[11px] text-stone-400">
                              Generation {gen + 1}
                            </div>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          )}

          <div className="relative">
            <button
              type="button"
              onClick={() => setShareMenuOpen((o) => !o)}
              title="Export or Share"
              className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-xl bg-white hover:bg-stone-100 border border-stone-200/90 text-stone-700 text-xs sm:text-sm font-medium shadow-xs transition-all cursor-pointer"
            >
              <Share2 className="w-4 h-4" />
              <span className="hidden sm:inline">Share</span>
            </button>
            {shareMenuOpen && (
              <div className="absolute right-0 mt-1.5 w-52 bg-white rounded-2xl shadow-xl border border-stone-200/90 py-1.5 z-50">
                <button
                  type="button"
                  disabled={treeState.people.length === 0}
                  onClick={handleExportPng}
                  className="w-full px-3.5 py-2 flex items-center gap-2.5 text-xs font-medium text-stone-700 hover:bg-amber-50/70 disabled:opacity-40 disabled:cursor-not-allowed text-left cursor-pointer"
                >
                  <ImageIcon className="w-4 h-4 text-amber-600" />
                  <span>Download Image (PNG)</span>
                </button>
                <button
                  type="button"
                  disabled={treeState.people.length === 0}
                  onClick={handleCopyShareLink}
                  className="w-full px-3.5 py-2 flex items-center gap-2.5 text-xs font-medium text-stone-700 hover:bg-sky-50/70 disabled:opacity-40 disabled:cursor-not-allowed text-left cursor-pointer"
                >
                  <Link2 className="w-4 h-4 text-sky-600" />
                  <span>Copy Shareable Link</span>
                </button>
                <div className="my-1 border-t border-stone-100" />
                <button
                  type="button"
                  disabled={treeState.people.length === 0}
                  onClick={handleExportJson}
                  className="w-full px-3.5 py-2 flex items-center gap-2.5 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-40 disabled:cursor-not-allowed text-left cursor-pointer"
                >
                  <Download className="w-4 h-4 text-stone-500" />
                  <span>Export Backup (JSON)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShareMenuOpen(false);
                    fileInputRef.current?.click();
                  }}
                  className="w-full px-3.5 py-2 flex items-center gap-2.5 text-xs font-medium text-stone-700 hover:bg-stone-50 text-left cursor-pointer"
                >
                  <Upload className="w-4 h-4 text-stone-500" />
                  <span>Import Backup (JSON)</span>
                </button>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleImportJson}
              className="hidden"
            />
          </div>

          <button
            type="button"
            onClick={() => openAddModal('independent')}
            className="inline-flex items-center gap-1.5 px-3 sm:px-3.5 py-1.5 sm:py-2 rounded-xl bg-stone-900 hover:bg-stone-800 active:scale-[0.98] text-white text-xs sm:text-sm font-medium shadow-xs transition-all cursor-pointer"
          >
            <UserPlus className="w-4 h-4" />
            <span>Add Person</span>
          </button>

          {treeState.people.length > 0 && (
            <button
              type="button"
              onClick={() => setModal({ type: 'reset_confirm' })}
              title="Clear family tree"
              className="p-2 rounded-xl text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
              aria-label="Clear family tree"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          )}
        </div>
      </header>

      {/* MAIN INTERACTIVE TREE CANVAS */}
      <main
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onWheel={handleWheel}
        onClick={() => {
          if (searchOpen) setSearchOpen(false);
          if (shareMenuOpen) setShareMenuOpen(false);
        }}
        className={`relative flex-1 overflow-hidden touch-none ${
          isPanning ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(168, 162, 158, 0.25) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
      >
        {/* EMPTY STATE ONBOARDING */}
        {treeState.people.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="w-full max-w-md bg-white/95 backdrop-blur-sm rounded-3xl shadow-xl shadow-stone-200/60 border border-stone-200/80 p-6 sm:p-8 text-center">
              <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center">
                <Users className="w-7 h-7" />
              </div>
              <h2 className="text-xl font-semibold text-stone-900 mb-1.5">
                Start Your Family Tree
              </h2>
              <p className="text-sm text-stone-500 mb-6 leading-relaxed">
                Enter your name or a family member&apos;s name to create the first
                person. You can add parents, spouses, and children next.
              </p>
              <form onSubmit={handleCreateFirstPerson} className="space-y-3">
                <input
                  type="text"
                  autoFocus
                  value={onboardingName}
                  onChange={(e) => setOnboardingName(e.target.value)}
                  placeholder="Enter a person's name (e.g., Your Name)"
                  className="w-full px-4 py-3 rounded-xl border border-stone-200 bg-stone-50/70 focus:bg-white focus:border-amber-400 focus:ring-2 focus:ring-amber-400/30 outline-none text-sm text-stone-900 placeholder:text-stone-400 transition-all"
                />
                <button
                  type="submit"
                  disabled={!onboardingName.trim()}
                  className="w-full py-3 rounded-xl bg-stone-900 hover:bg-stone-800 disabled:bg-stone-300 disabled:cursor-not-allowed text-white text-sm font-medium shadow-sm transition-all cursor-pointer"
                >
                  Add First Person
                </button>
              </form>
            </div>
          </div>
        ) : (
          /* TRANSFORMED TREE STAGE */
          <div
            className="absolute top-0 left-0 origin-top-left transition-transform duration-75 ease-out"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            }}
          >
            {/* SVG CONNECTING LINES */}
            <svg
              className="pointer-events-none overflow-visible"
              style={{
                position: 'absolute',
                left: svgBounds.minX,
                top: svgBounds.minY,
                width: svgBounds.width,
                height: svgBounds.height,
              }}
              viewBox={`${svgBounds.minX} ${svgBounds.minY} ${svgBounds.width} ${svgBounds.height}`}
            >
              {/* Parent-Child Lines */}
              {layout.parentChildEdges.map((edge) => {
                const midY = (edge.parentY + edge.childY) / 2;
                const isHighlighted =
                  selectedPersonId &&
                  (edge.childId === selectedPersonId ||
                    edge.parentIds.includes(selectedPersonId));
                const d = `M ${edge.parentX} ${edge.parentY} L ${edge.parentX} ${midY} L ${edge.childX} ${midY} L ${edge.childX} ${edge.childY}`;
                return (
                  <g key={edge.id}>
                    <path
                      d={d}
                      fill="none"
                      stroke={isHighlighted ? '#D97706' : '#CBD5E1'}
                      strokeWidth={isHighlighted ? 2.5 : 2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="transition-colors duration-200"
                    />
                    <circle
                      cx={edge.childX}
                      cy={edge.childY}
                      r={3.5}
                      fill={isHighlighted ? '#D97706' : '#94A3B8'}
                    />
                  </g>
                );
              })}

              {/* Spouse Lines */}
              {layout.spouseEdges.map((edge) => {
                const isHighlighted =
                  selectedPersonId &&
                  (edge.fromId === selectedPersonId || edge.toId === selectedPersonId);
                const midX = (edge.x1 + edge.x2) / 2;
                const midY = (edge.y1 + edge.y2) / 2;
                return (
                  <g key={edge.id}>
                    <line
                      x1={edge.x1}
                      y1={edge.y1}
                      x2={edge.x2}
                      y2={edge.y2}
                      stroke={isHighlighted ? '#E11D48' : '#FDA4AF'}
                      strokeWidth={isHighlighted ? 2.5 : 2}
                      strokeDasharray={isHighlighted ? undefined : '4 3'}
                    />
                    <circle
                      cx={midX}
                      cy={midY}
                      r={9}
                      fill="#FFF1F2"
                      stroke={isHighlighted ? '#E11D48' : '#FDA4AF'}
                      strokeWidth={1.5}
                    />
                    <path
                      d={`M ${midX} ${midY + 3.2} C ${midX - 4.5} ${midY}, ${midX - 4.5} ${midY - 3.5}, ${midX - 2} ${midY - 3.5} C ${midX - 0.8} ${midY - 3.5}, ${midX} ${midY - 2.3}, ${midX} ${midY - 2.3} C ${midX} ${midY - 2.3}, ${midX + 0.8} ${midY - 3.5}, ${midX + 2} ${midY - 3.5} C ${midX + 4.5} ${midY - 3.5}, ${midX + 4.5} ${midY}, ${midX} ${midY + 3.2} Z`}
                      fill="#E11D48"
                    />
                  </g>
                );
              })}
            </svg>

            {/* PERSON CARDS */}
            {layout.nodes.map((node) => {
              const { person, x, y, generation, hasChildren, isCollapsed, hiddenDescendantCount } =
                node;
              const style = getGenStyle(generation);
              const isSelected = selectedPersonId === person.id;

              return (
                <div
                  key={person.id}
                  data-person-node="true"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedPersonId(person.id);
                  }}
                  style={{
                    left: x,
                    top: y,
                    width: CARD_WIDTH,
                    height: CARD_HEIGHT,
                  }}
                  className={`absolute rounded-2xl border backdrop-blur-sm shadow-sm hover:shadow-md transition-all duration-200 cursor-pointer flex items-center gap-3 px-3.5 ${
                    style.cardBg
                  } ${isSelected ? style.selectedBorder : style.border}`}
                >
                  {/* Subtle top generation accent */}
                  <div
                    className={`absolute top-0 left-4 right-4 h-1 rounded-b-full opacity-75 ${style.accentBar}`}
                  />

                  <PersonAvatar person={person} generation={generation} size="md" />

                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-stone-900 truncate leading-snug">
                      {person.name}
                    </div>
                    <div className="mt-0.5 inline-flex items-center">
                      <span
                        className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md ${style.badge}`}
                      >
                        Gen {generation + 1}
                      </span>
                    </div>
                  </div>

                  {/* Expand / Collapse Branch Toggle */}
                  {hasChildren && (
                    <button
                      type="button"
                      onClick={(e) => toggleCollapse(person.id, e)}
                      title={isCollapsed ? 'Expand branch' : 'Collapse branch'}
                      className="absolute -bottom-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full bg-white border border-stone-200 shadow-xs text-[11px] font-medium text-stone-600 hover:text-stone-900 hover:border-stone-300 transition-colors cursor-pointer"
                    >
                      {isCollapsed ? (
                        <>
                          <ChevronDown className="w-3 h-3" />
                          <span>+{hiddenDescendantCount}</span>
                        </>
                      ) : (
                        <ChevronUp className="w-3 h-3" />
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* FLOATING ZOOM & FIT CONTROLS */}
        {treeState.people.length > 0 && (
          <div className="absolute bottom-4 right-4 z-20 flex items-center gap-1 bg-white/90 backdrop-blur-md border border-stone-200/90 rounded-2xl p-1.5 shadow-md">
            <button
              type="button"
              onClick={() => zoomBy(1 / 1.15)}
              title="Zoom out (-)"
              className="p-2 rounded-xl text-stone-600 hover:bg-stone-100 hover:text-stone-900 transition-colors cursor-pointer"
              aria-label="Zoom out"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-xs font-medium text-stone-600 w-11 text-center tabular-nums">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => zoomBy(1.15)}
              title="Zoom in (+)"
              className="p-2 rounded-xl text-stone-600 hover:bg-stone-100 hover:text-stone-900 transition-colors cursor-pointer"
              aria-label="Zoom in"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <div className="w-px h-5 bg-stone-200 mx-0.5" />
            <button
              type="button"
              onClick={fitToScreen}
              title="Fit entire tree to screen"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium text-stone-700 hover:bg-stone-100 hover:text-stone-900 transition-colors cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Fit</span>
            </button>
          </div>
        )}

        {/* SELECTED PERSON ACTION MENU (Responsive floating card / bottom sheet) */}
        {selectedPerson && modal.type === 'none' && (
          <aside
            data-person-node="true"
            className="absolute z-30 bottom-3 left-3 right-3 sm:right-auto sm:top-4 sm:bottom-auto sm:left-4 sm:w-80 bg-white/95 backdrop-blur-md rounded-3xl border border-stone-200/90 shadow-xl p-4 sm:p-5 transition-all"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="flex items-center gap-3 min-w-0">
                <PersonAvatar
                  person={selectedPerson}
                  generation={layout.generations.get(selectedPerson.id) ?? 0}
                  size="lg"
                />
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-stone-900 truncate">
                    {selectedPerson.name}
                  </h2>
                  <p className="text-xs text-stone-500">
                    Generation {(layout.generations.get(selectedPerson.id) ?? 0) + 1}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedPersonId(null)}
                className="p-1.5 rounded-xl text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
                aria-label="Close menu"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Existing connections summary */}
            {(selectedRelations.parents.length > 0 ||
              selectedRelations.spouses.length > 0 ||
              selectedRelations.children.length > 0) && (
              <div className="mb-3.5 p-2.5 rounded-2xl bg-stone-50 border border-stone-100 space-y-1.5 max-h-32 overflow-y-auto">
                {selectedRelations.parents.map(({ relId, person }) => (
                  <div
                    key={relId}
                    className="flex items-center justify-between text-xs text-stone-600"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedPersonId(person.id);
                        focusNode(person.id);
                      }}
                      className="truncate hover:text-stone-900 text-left cursor-pointer"
                    >
                      <span className="text-stone-400 mr-1">Parent:</span>
                      <span className="font-medium">{person.name}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveRelationship(relId)}
                      title="Remove connection"
                      className="text-stone-400 hover:text-rose-600 p-0.5 shrink-0 cursor-pointer"
                    >
                      <Unlink className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                {selectedRelations.spouses.map(({ relId, person }) => (
                  <div
                    key={relId}
                    className="flex items-center justify-between text-xs text-stone-600"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedPersonId(person.id);
                        focusNode(person.id);
                      }}
                      className="truncate hover:text-stone-900 text-left cursor-pointer"
                    >
                      <span className="text-rose-500 mr-1">Spouse:</span>
                      <span className="font-medium">{person.name}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveRelationship(relId)}
                      title="Remove connection"
                      className="text-stone-400 hover:text-rose-600 p-0.5 shrink-0 cursor-pointer"
                    >
                      <Unlink className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                {selectedRelations.children.map(({ relId, person }) => (
                  <div
                    key={relId}
                    className="flex items-center justify-between text-xs text-stone-600"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedPersonId(person.id);
                        focusNode(person.id);
                      }}
                      className="truncate hover:text-stone-900 text-left cursor-pointer"
                    >
                      <span className="text-stone-400 mr-1">Child:</span>
                      <span className="font-medium">{person.name}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveRelationship(relId)}
                      title="Remove connection"
                      className="text-stone-400 hover:text-rose-600 p-0.5 shrink-0 cursor-pointer"
                    >
                      <Unlink className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* 6 Core Actions */}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => openAddModal('parent', selectedPerson.id)}
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-stone-50 hover:bg-amber-50 border border-stone-200/80 hover:border-amber-200 text-xs font-medium text-stone-800 transition-colors cursor-pointer"
              >
                <ArrowUp className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                <span>Add Parent</span>
              </button>

              <button
                type="button"
                onClick={() => openAddModal('child', selectedPerson.id)}
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-stone-50 hover:bg-emerald-50 border border-stone-200/80 hover:border-emerald-200 text-xs font-medium text-stone-800 transition-colors cursor-pointer"
              >
                <ArrowDown className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span>Add Child</span>
              </button>

              <button
                type="button"
                onClick={() => openAddModal('spouse', selectedPerson.id)}
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-stone-50 hover:bg-rose-50 border border-stone-200/80 hover:border-rose-200 text-xs font-medium text-stone-800 transition-colors cursor-pointer"
              >
                <Heart className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                <span>Add Spouse</span>
              </button>

              <button
                type="button"
                disabled={treeState.people.length < 2}
                onClick={() => openConnectExistingModal(selectedPerson.id)}
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-stone-50 hover:bg-sky-50 border border-stone-200/80 hover:border-sky-200 disabled:opacity-45 disabled:cursor-not-allowed text-xs font-medium text-stone-800 transition-colors cursor-pointer"
              >
                <Link2 className="w-3.5 h-3.5 text-sky-600 shrink-0" />
                <span>Connect Existing</span>
              </button>

              <button
                type="button"
                onClick={() => openRenameModal(selectedPerson.id)}
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-stone-50 hover:bg-stone-100 border border-stone-200/80 text-xs font-medium text-stone-700 transition-colors cursor-pointer"
              >
                <Pencil className="w-3.5 h-3.5 text-stone-500 shrink-0" />
                <span>Rename</span>
              </button>

              <button
                type="button"
                onClick={() =>
                  setModal({ type: 'delete_confirm', targetPersonId: selectedPerson.id })
                }
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-stone-50 hover:bg-rose-50 border border-stone-200/80 hover:border-rose-200 text-xs font-medium text-rose-600 transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5 shrink-0" />
                <span>Delete</span>
              </button>
            </div>
          </aside>
        )}
      </main>

      {/* TOAST NOTIFICATION */}
      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-stone-900 text-white text-xs sm:text-sm font-medium shadow-lg flex items-center gap-2 pointer-events-none">
          <Check className="w-3.5 h-3.5 text-emerald-400" />
          <span>{toast.message}</span>
        </div>
      )}

      {/* MODALS */}
      {modal.type !== 'none' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/35 backdrop-blur-xs"
          onClick={() => setModal({ type: 'none' })}
        >
          <div
            className="w-full max-w-md bg-white rounded-3xl shadow-2xl border border-stone-200 p-5 sm:p-6"
            onClick={(e) => e.stopPropagation()}
          >
            {/* ADD PERSON MODAL */}
            {modal.type === 'add_person' && (
              <form onSubmit={handleAddPersonSubmit} className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-stone-900">
                    {modal.mode === 'independent' && 'Add Family Member'}
                    {modal.mode === 'parent' &&
                      `Add Parent of ${personMap.get(modal.targetPersonId || '')?.name || ''}`}
                    {modal.mode === 'child' &&
                      `Add Child of ${personMap.get(modal.targetPersonId || '')?.name || ''}`}
                    {modal.mode === 'spouse' &&
                      `Add Spouse of ${personMap.get(modal.targetPersonId || '')?.name || ''}`}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setModal({ type: 'none' })}
                    className="p-1.5 rounded-xl text-stone-400 hover:bg-stone-100 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div>
                  <label className="block text-xs font-medium text-stone-600 mb-1.5">
                    Full Name
                  </label>
                  <input
                    type="text"
                    autoFocus
                    value={nameInput}
                    onChange={(e) => {
                      setNameInput(e.target.value);
                      setFormError(null);
                    }}
                    placeholder="Enter name..."
                    className="w-full px-3.5 py-2.5 rounded-xl border border-stone-200 bg-stone-50/70 focus:bg-white focus:border-amber-400 focus:ring-2 focus:ring-amber-400/30 outline-none text-sm text-stone-900"
                  />
                </div>

                {modal.mode === 'child' &&
                  modal.targetPersonId &&
                  getSpouses(modal.targetPersonId, treeState.relationships).length === 1 && (
                    <label className="flex items-center gap-2.5 p-3 rounded-xl bg-stone-50 border border-stone-200/80 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={alsoConnectSpouse}
                        onChange={(e) => setAlsoConnectSpouse(e.target.checked)}
                        className="rounded border-stone-300 text-stone-900 focus:ring-amber-400"
                      />
                      <span className="text-xs text-stone-700">
                        Also connect{' '}
                        <strong>
                          {
                            personMap.get(
                              getSpouses(
                                modal.targetPersonId,
                                treeState.relationships
                              )[0]
                            )?.name
                          }
                        </strong>{' '}
                        as parent
                      </span>
                    </label>
                  )}

                {formError && (
                  <div className="flex items-center gap-2 text-xs text-rose-600 bg-rose-50 px-3 py-2 rounded-xl">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{formError}</span>
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setModal({ type: 'none' })}
                    className="px-4 py-2 rounded-xl text-sm font-medium text-stone-600 hover:bg-stone-100 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-xl text-sm font-medium bg-stone-900 hover:bg-stone-800 text-white cursor-pointer"
                  >
                    Add Person
                  </button>
                </div>
              </form>
            )}

            {/* CONNECT EXISTING PERSON MODAL */}
            {modal.type === 'connect_existing' && (
              <form onSubmit={handleConnectExistingSubmit} className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-stone-900">
                    Connect Existing Person
                  </h3>
                  <button
                    type="button"
                    onClick={() => setModal({ type: 'none' })}
                    className="p-1.5 rounded-xl text-stone-400 hover:bg-stone-100 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div>
                  <label className="block text-xs font-medium text-stone-600 mb-1.5">
                    Select Person
                  </label>
                  <select
                    value={connectOtherId}
                    onChange={(e) => {
                      setConnectOtherId(e.target.value);
                      setFormError(null);
                    }}
                    className="w-full px-3.5 py-2.5 rounded-xl border border-stone-200 bg-stone-50/70 focus:bg-white focus:border-amber-400 outline-none text-sm text-stone-900"
                  >
                    {treeState.people
                      .filter((p) => p.id !== modal.targetPersonId)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-stone-600 mb-1.5">
                    Relationship
                  </label>
                  <div className="space-y-2">
                    {[
                      {
                        value: 'other_is_parent' as const,
                        label: `${personMap.get(connectOtherId)?.name || 'Selected person'} is the Parent of ${personMap.get(modal.targetPersonId)?.name || ''}`,
                      },
                      {
                        value: 'other_is_child' as const,
                        label: `${personMap.get(connectOtherId)?.name || 'Selected person'} is the Child of ${personMap.get(modal.targetPersonId)?.name || ''}`,
                      },
                      {
                        value: 'spouse' as const,
                        label: `${personMap.get(connectOtherId)?.name || 'Selected person'} and ${personMap.get(modal.targetPersonId)?.name || ''} are Spouses`,
                      },
                    ].map((opt) => (
                      <label
                        key={opt.value}
                        className={`flex items-center gap-2.5 p-3 rounded-xl border text-xs cursor-pointer transition-colors ${
                          connectDirection === opt.value
                            ? 'bg-amber-50/80 border-amber-300 text-stone-900 font-medium'
                            : 'bg-stone-50/60 border-stone-200 text-stone-700 hover:bg-stone-100/70'
                        }`}
                      >
                        <input
                          type="radio"
                          name="connectDirection"
                          value={opt.value}
                          checked={connectDirection === opt.value}
                          onChange={() => {
                            setConnectDirection(opt.value);
                            setFormError(null);
                          }}
                          className="text-amber-600 focus:ring-amber-400"
                        />
                        <span>{opt.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {formError && (
                  <div className="flex items-center gap-2 text-xs text-rose-600 bg-rose-50 px-3 py-2 rounded-xl">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{formError}</span>
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setModal({ type: 'none' })}
                    className="px-4 py-2 rounded-xl text-sm font-medium text-stone-600 hover:bg-stone-100 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-xl text-sm font-medium bg-stone-900 hover:bg-stone-800 text-white cursor-pointer"
                  >
                    Connect
                  </button>
                </div>
              </form>
            )}

            {/* RENAME PERSON MODAL */}
            {modal.type === 'rename' && (
              <form onSubmit={handleRenameSubmit} className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-stone-900">
                    Rename Person
                  </h3>
                  <button
                    type="button"
                    onClick={() => setModal({ type: 'none' })}
                    className="p-1.5 rounded-xl text-stone-400 hover:bg-stone-100 cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <input
                  type="text"
                  autoFocus
                  value={nameInput}
                  onChange={(e) => {
                    setNameInput(e.target.value);
                    setFormError(null);
                  }}
                  placeholder="Enter new name..."
                  className="w-full px-3.5 py-2.5 rounded-xl border border-stone-200 bg-stone-50/70 focus:bg-white focus:border-amber-400 focus:ring-2 focus:ring-amber-400/30 outline-none text-sm text-stone-900"
                />
                {formError && (
                  <div className="flex items-center gap-2 text-xs text-rose-600 bg-rose-50 px-3 py-2 rounded-xl">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{formError}</span>
                  </div>
                )}
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setModal({ type: 'none' })}
                    className="px-4 py-2 rounded-xl text-sm font-medium text-stone-600 hover:bg-stone-100 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-xl text-sm font-medium bg-stone-900 hover:bg-stone-800 text-white cursor-pointer"
                  >
                    Save Name
                  </button>
                </div>
              </form>
            )}

            {/* DELETE CONFIRMATION MODAL */}
            {modal.type === 'delete_confirm' && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-stone-900">
                  Delete {personMap.get(modal.targetPersonId)?.name}?
                </h3>
                <p className="text-sm text-stone-600 leading-relaxed">
                  This will remove{' '}
                  <strong>{personMap.get(modal.targetPersonId)?.name}</strong> and
                  all of their relationships from the family tree.
                </p>
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setModal({ type: 'none' })}
                    className="px-4 py-2 rounded-xl text-sm font-medium text-stone-600 hover:bg-stone-100 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeletePerson(modal.targetPersonId)}
                    className="px-4 py-2 rounded-xl text-sm font-medium bg-rose-600 hover:bg-rose-700 text-white cursor-pointer"
                  >
                    Delete Person
                  </button>
                </div>
              </div>
            )}

            {/* RESET TREE CONFIRMATION MODAL */}
            {modal.type === 'reset_confirm' && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-stone-900">
                  Clear Entire Family Tree?
                </h3>
                <p className="text-sm text-stone-600 leading-relaxed">
                  This will permanently remove all {treeState.people.length} people
                  and {treeState.relationships.length} relationships saved in this
                  browser.
                </p>
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setModal({ type: 'none' })}
                    className="px-4 py-2 rounded-xl text-sm font-medium text-stone-600 hover:bg-stone-100 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleResetTree}
                    className="px-4 py-2 rounded-xl text-sm font-medium bg-rose-600 hover:bg-rose-700 text-white cursor-pointer"
                  >
                    Clear Tree
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
