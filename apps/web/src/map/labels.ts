/**
 * The location map's words (1.x, D237): model names, room kinds and floors, in the reader's
 * language.
 */
import type { MapModelKey, MapRoomKind, MapSurface, ShapeGroup } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { useMemo } from 'react';

export function useModelNames(): Record<MapModelKey, string> {
  const { t } = useLingui();
  return useMemo(
    () => ({
      sofa: t`Sofa`,
      armchair: t`Armchair`,
      coffee_table: t`Coffee table`,
      tv_stand: t`TV stand`,
      cube_shelf: t`Cube shelf`,
      tall_plant: t`Tall plant`,
      plant: t`Plant`,
      succulent: t`Succulent`,
      dining_chair: t`Dining chair`,
      drawers: t`Chest of drawers`,
      bedside: t`Bedside table`,
      metal_shelf: t`Metal shelf`,
      tool_cart: t`Tool cart`,
      drill: t`Drill`,
      cardboard: t`Moving box`,
      crate: t`Crate`,
      basket: t`Basket`,
      outdoor_set: t`Bistro set`,
      monobloc: t`Plastic chair`,
      planter: t`Planter`,
      planter_long: t`Long planter`,
      ac_unit: t`AC outdoor unit`,
      watering_can: t`Watering can`,
      tv: t`TV`,
      bookshelf: t`Bookshelf`,
      lamp: t`Floor lamp`,
      counter: t`Kitchen counter`,
      sink: t`Sink counter`,
      fridge: t`Fridge`,
      coffee_machine: t`Coffee machine`,
      microwave: t`Microwave`,
      dining: t`Dining table`,
      bed: t`Bed`,
      wardrobe: t`Wardrobe`,
      table_lamp: t`Table lamp`,
      desk: t`Desk`,
      monitor: t`Monitor`,
      laptop: t`Laptop`,
      device: t`Small device`,
      chair: t`Desk chair`,
      cabinet: t`Filing cabinet`,
      box: t`Storage box`,
      washer: t`Washing machine`,
      workbench: t`Workbench`,
      tool_wall: t`Tool wall`,
      car: t`Car`,
      bike: t`Bike`,
      water_tank: t`Water tank`,
      dish: t`Satellite dish`,
      stairs: t`Stairs`,
      stairwell: t`Stairwell`,
      zone: t`Area`,
      item: t`Small thing`,
    }),
    [t],
  );
}

export function useRoomKindNames(): Record<MapRoomKind, string> {
  const { t } = useLingui();
  return useMemo(
    () => ({ room: t`Room`, balcony: t`Balcony`, terrace: t`Terrace`, garden: t`Garden` }),
    [t],
  );
}

export function useSurfaceNames(): Record<MapSurface, string> {
  const { t } = useLingui();
  return useMemo(
    () => ({
      wood: t`Wood`,
      tile: t`Tiles`,
      concrete: t`Concrete`,
      deck: t`Deck`,
      grass: t`Grass`,
    }),
    [t],
  );
}

/** The shape picker's groups (D249). */
export function useShapeGroupNames(): Record<ShapeGroup, string> {
  const { t } = useLingui();
  return useMemo(
    () => ({
      furniture: t`Furniture`,
      storage: t`Storage`,
      electronics: t`Electronics`,
      kitchen: t`Kitchen and laundry`,
      tools: t`Tools`,
      outdoor: t`Plants and outdoor`,
      vehicles: t`Vehicles`,
      building: t`Stairs and areas`,
      other: t`Other`,
    }),
    [t],
  );
}
