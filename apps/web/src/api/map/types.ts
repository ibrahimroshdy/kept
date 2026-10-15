/**
 * The location map's types (1.x, D237), as `apps/server/src/map/{view,service}.ts` answer them.
 * Layout positions and sizes are whole centimetres; the map draws in metres.
 */
import type { MapRoomKind, MapSurface } from '@kept/shared';

export type MapRoomLayout = {
  x: number;
  z: number;
  w: number;
  d: number;
  kind: MapRoomKind;
  surface: MapSurface;
};

export type MapNodeLayout = {
  x: number;
  z: number;
  rot: number;
  model: string | null;
  hostId: string | null;
};

export type MapLevelView = { id: string | null; name: string | null };

export type MapRoomView = {
  id: string;
  name: string;
  shortCode: string | null;
  levelId: string | null;
  kindKey: string;
  layout: MapRoomLayout | null;
};

export type MapNodeView = {
  id: string;
  subject: 'place' | 'thing';
  name: string;
  shortCode: string | null;
  roomId: string;
  /** The nearest room or node above it in Kept's tree. */
  parentId: string;
  kindKey: string | null;
  typeKey: string | null;
  isContainer: boolean;
  quantity: number;
  layout: MapNodeLayout | null;
};

export type MapThingView = {
  id: string;
  name: string;
  shortCode: string | null;
  quantity: number;
  parentId: string;
};

export type MapAttentionKind = 'low' | 'lent' | 'due';

export type MapAttention = {
  subjectId: string;
  kind: MapAttentionKind;
  title: string | null;
  sourceType: string | null;
  state: string | null;
  dueOn: string | null;
  person: string | null;
  quantity: number | null;
  min: number | null;
};

/** GET /api/v1/locations/:id/map */
export type MapView = {
  locationId: string;
  canArrange: boolean;
  version: string | null;
  levels: MapLevelView[];
  rooms: MapRoomView[];
  nodes: MapNodeView[];
  things: MapThingView[];
  more: number;
  attention: MapAttention[];
};

/** PUT /api/v1/locations/:id/layout: the whole layout of one arrange session. */
export type LayoutBody = {
  version: string | null;
  rooms: ({ id: string } & MapRoomLayout)[];
  nodes: { id: string; x: number; z: number; rot: number; model: string; hostId: string | null }[];
};
