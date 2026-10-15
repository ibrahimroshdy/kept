/**
 * The shape picker's sprite (D249), written by scripts/render-map-thumbs.mjs: don't edit by hand.
 * Each shape's picture is one CELL px square cell of shapes.webp, COLS cells per row.
 */
import type { MapModelKey } from '@kept/shared';

export const THUMB_CELL = 88;
export const THUMB_COLS = 8;
export const THUMB_ROWS = 7;

/** Each shape's cell, row by row. */
export const THUMB_CELLS: Readonly<Record<MapModelKey, number>> = {
  sofa: 0,
  armchair: 1,
  coffee_table: 2,
  tv_stand: 3,
  cube_shelf: 4,
  tall_plant: 5,
  plant: 6,
  succulent: 7,
  dining_chair: 8,
  drawers: 9,
  bedside: 10,
  metal_shelf: 11,
  tool_cart: 12,
  drill: 13,
  cardboard: 14,
  crate: 15,
  basket: 16,
  outdoor_set: 17,
  monobloc: 18,
  planter: 19,
  planter_long: 20,
  ac_unit: 21,
  watering_can: 22,
  tv: 23,
  bookshelf: 24,
  lamp: 25,
  counter: 26,
  sink: 27,
  fridge: 28,
  coffee_machine: 29,
  microwave: 30,
  dining: 31,
  bed: 32,
  wardrobe: 33,
  table_lamp: 34,
  desk: 35,
  monitor: 36,
  laptop: 37,
  device: 38,
  chair: 39,
  cabinet: 40,
  box: 41,
  washer: 42,
  workbench: 43,
  tool_wall: 44,
  car: 45,
  bike: 46,
  water_tank: 47,
  dish: 48,
  stairs: 49,
  stairwell: 50,
  zone: 51,
  item: 52,
};
