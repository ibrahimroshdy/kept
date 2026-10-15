import { describe, expect, it } from 'vitest';
import { MAP_MODEL_KEYS, MAP_MODELS, mapModel } from './map.js';
import {
  foldText,
  SHAPE_GROUP,
  SHAPE_GROUPS,
  SHAPE_WORDS,
  type ShapeInput,
  searchShapes,
  shapeOnAdd,
  suggestShapes,
} from './map-shapes.js';

const first = (input: ShapeInput) => suggestShapes(input).shapes[0]?.model;
const sure = (input: ShapeInput) => suggestShapes(input).confident;

describe('the shape catalogue (D249)', () => {
  it('puts every shape in a group and gives it words', () => {
    for (const key of MAP_MODEL_KEYS) {
      expect(SHAPE_GROUPS, key).toContain(SHAPE_GROUP[key]);
      expect(SHAPE_WORDS[key].length, key).toBeGreaterThan(0);
    }
  });

  it('has a small device for gadgets with no model of their own, at a gadget’s size', () => {
    const d = mapModel('device');
    expect(d.w).toBeLessThanOrEqual(0.3);
    expect(d.d).toBeLessThanOrEqual(0.3);
    expect(d.h).toBeLessThanOrEqual(0.15);
    expect(d.small).toBe(true);
    expect(MAP_MODELS.device.kind).toBe('thing');
  });

  it('folds accents, ß and Arabic letter forms', () => {
    expect(foldText('Téléviseur')).toBe('televiseur');
    expect(foldText('Gießkanne')).toBe('giesskanne');
    expect(foldText('ثلاجة')).toBe('ثلاجه');
    expect(foldText('أريكة')).toBe('اريكه');
    expect(foldText('TV-Möbel')).toBe('tv mobel');
  });
});

describe('suggestShapes: the type first', () => {
  it('gives a TV-type thing the TV shape, confidently, whatever its name', () => {
    const s = suggestShapes({ name: 'Living room 55"', typeKey: 'tv_display' });
    expect(s.shapes[0]).toMatchObject({ model: 'tv', from: 'type' });
    expect(s.confident).toBe(true);
    expect(s.shapes[0]?.score).toBeGreaterThanOrEqual(0.9);
  });

  it('names cars, bicycles, motorbikes and boxes from the type', () => {
    expect(first({ name: 'Corolla', typeKey: 'car' })).toBe('car');
    expect(first({ name: 'Brompton', typeKey: 'bicycle' })).toBe('bike');
    expect(first({ name: 'Vespa', typeKey: 'motorbike' })).toBe('bike');
    expect(first({ name: 'Winter things', typeKey: 'box_bin', isContainer: true })).toBe('box');
    for (const typeKey of ['car', 'bicycle', 'motorbike', 'box_bin'])
      expect(sure({ name: 'X1', typeKey }), typeKey).toBe(true);
  });

  it('only ranks from a category, never decides', () => {
    const s = suggestShapes({ name: 'Thing 12', typeKey: 'electronics' });
    expect(s.shapes.map((x) => x.model)).toEqual(
      expect.arrayContaining(['tv', 'monitor', 'laptop', 'device']),
    );
    expect(s.confident).toBe(false);
    expect(sure({ name: 'Bosch thing', typeKey: 'large_appliance' })).toBe(false);
  });

  it('reads a custom type’s own name as the type', () => {
    const s = suggestShapes({ name: 'Wohnzimmer', typeName: 'Fernseher' });
    expect(s.shapes[0]).toMatchObject({ model: 'tv', from: 'type' });
    expect(s.confident).toBe(true);
  });

  it('is not sure when the type and the name disagree', () => {
    const s = suggestShapes({ name: 'LG monitor', typeKey: 'tv_display' });
    expect(s.shapes[0]?.model).toBe('monitor');
    expect(s.shapes.map((x) => x.model)).toContain('tv');
    expect(s.confident).toBe(false);
  });
});

describe('suggestShapes: then the name, in five languages', () => {
  it.each([
    ['Samsung TV, 55″', 'tv'],
    ['Sony Fernseher', 'tv'],
    ['Flachbildfernseher', 'tv'],
    ['téléviseur du salon', 'tv'],
    ['Televisore Philips', 'tv'],
    ['تلفزيون الصالة', 'tv'],
    ['تلفاز Samsung', 'tv'],
    ['Kühlschrank', 'fridge'],
    ['Réfrigérateur', 'fridge'],
    ['frigorifero', 'fridge'],
    ['ثلاجة المطبخ', 'fridge'],
    ['Waschmaschine', 'washer'],
    ['Lave-linge', 'washer'],
    ['lavatrice', 'washer'],
    ['غسالة', 'washer'],
    ['Canapé', 'sofa'],
    ['divano letto', 'sofa'],
    ['الكنبة', 'sofa'],
    ['MacBook Air', 'laptop'],
    ['Ordinateur portable', 'laptop'],
    ['لابتوب', 'laptop'],
    ['Dell monitor', 'monitor'],
    ['Bike', 'bike'],
    ['Fahrrad', 'bike'],
    ['دراجة', 'bike'],
    ['Bohrmaschine', 'drill'],
    ['Perceuse', 'drill'],
    ['Trapano', 'drill'],
    ['Moving boxes', 'cardboard'],
    ['Gießkanne', 'watering_can'],
  ] as const)('%s → %s', (name, model) => {
    expect(first({ name })).toBe(model);
  });

  it('gives a clear name’s shape by itself', () => {
    expect(sure({ name: 'Samsung TV' })).toBe(true);
    expect(sure({ name: 'Fernseher' })).toBe(true);
    expect(sure({ name: 'تلفزيون' })).toBe(true);
    expect(sure({ name: 'Kühlschrank' })).toBe(true);
  });

  it('lets a longer phrase win over a word inside it', () => {
    expect(first({ name: 'TV stand' })).toBe('tv_stand');
    expect(first({ name: 'Meuble TV' })).toBe('tv_stand');
    expect(first({ name: 'حامل تلفاز' })).toBe('tv_stand');
    expect(first({ name: 'Coffee table' })).toBe('coffee_table');
    expect(first({ name: 'Macchina da caffè' })).toBe('coffee_machine');
    expect(first({ name: 'Bedside table' })).toBe('bedside');
    expect(sure({ name: 'TV stand' })).toBe(true);
  });

  it('is not sure about a word with two meanings', () => {
    const s = suggestShapes({ name: 'Screen' });
    expect(s.shapes.slice(0, 2).map((x) => x.model)).toEqual(['tv', 'monitor']);
    expect(s.confident).toBe(false);
    expect(sure({ name: 'شاشة' })).toBe(false);
  });

  it('is less sure about the end of a compound than a whole word', () => {
    const s = suggestShapes({ name: 'Flachbildfernseher' });
    expect(s.shapes[0]?.score).toBeLessThan(0.9);
    expect(s.confident).toBe(false);
  });

  it('does not read words inside other words', () => {
    expect(first({ name: 'Cardigan' })).not.toBe('car');
    expect(first({ name: 'Scarf' })).not.toBe('car');
    expect(first({ name: 'Tube of glue' })).not.toBe('crate');
    expect(first({ name: 'Bathroom scale' })).not.toBe('stairs');
    // "controller" ends in "roller" (a German scooter): too short to be a compound's end.
    expect(suggestShapes({ name: 'PS5 controller' }).shapes.map((x) => x.model)).not.toContain(
      'bike',
    );
  });
});

describe('suggestShapes: the webcam, and things with no shape of their own', () => {
  it.each([
    'Logitech webcam',
    'Webcam',
    'Kamera',
    'caméra',
    'كاميرا',
    'Wi-Fi router',
    'Routeur',
    'Bluetooth speaker',
    'Lautsprecher',
    'altoparlante',
    'سماعة',
    'PlayStation 5',
    'PS5 controller',
    'يد تحكم PS5',
  ])('%s gets the small device, suggested but not given by itself', (name) => {
    const s = suggestShapes({ name });
    expect(s.shapes[0]?.model).toBe('device');
    expect(s.shapes[0]?.from).toBe('name');
    expect(s.confident).toBe(false);
  });

  it('suggests the small device for a camera-type thing, with a gadget’s size', () => {
    const s = suggestShapes({ name: 'Front door', typeKey: 'camera' });
    expect(s.shapes[0]?.model).toBe('device');
    expect(s.confident).toBe(false);
    const { model } = shapeOnAdd({ name: 'Front door', typeKey: 'camera' });
    expect(mapModel(model).w).toBeLessThan(0.3);
  });

  it('falls back to a small thing, never something absurd, when nothing fits', () => {
    const s = suggestShapes({ name: "Grandma's vase" });
    expect(s.shapes[0]).toMatchObject({ model: 'item', from: 'guess', score: 0 });
    expect(s.confident).toBe(false);
    expect(s.shapes.length).toBeGreaterThanOrEqual(3);
    for (const x of s.shapes) expect(mapModel(x.model).w, x.model).toBeLessThan(1);
  });

  it('falls back to storage for a container', () => {
    const s = suggestShapes({ name: 'Grey one', isContainer: true });
    expect(s.shapes.map((x) => x.model)).toEqual(['box', 'cardboard', 'crate']);
    expect(s.confident).toBe(false);
  });

  it('returns at least three and at most the limit', () => {
    expect(suggestShapes({ name: 'TV' }).shapes.length).toBeGreaterThanOrEqual(3);
    expect(suggestShapes({ name: 'x' }, 3).shapes).toHaveLength(3);
    const many = suggestShapes({ name: 'Tisch', typeKey: 'furniture' }, 6).shapes;
    expect(many.length).toBeLessThanOrEqual(6);
    expect(new Set(many.map((x) => x.model)).size).toBe(many.length);
  });
});

describe('shapeOnAdd', () => {
  it('never replaces a shape someone chose', () => {
    expect(shapeOnAdd({ name: 'Samsung TV', typeKey: 'tv_display' }, 'monitor')).toEqual({
      model: 'monitor',
      from: 'chosen',
    });
  });

  it('says where a confident shape came from, and that anything else is a guess', () => {
    expect(shapeOnAdd({ name: 'Living room', typeKey: 'tv_display' })).toEqual({
      model: 'tv',
      from: 'type',
    });
    expect(shapeOnAdd({ name: 'Samsung TV' })).toEqual({ model: 'tv', from: 'name' });
    expect(shapeOnAdd({ name: 'Logitech webcam' })).toEqual({ model: 'device', from: 'guess' });
    expect(shapeOnAdd({ name: 'Screen' })).toEqual({ model: 'tv', from: 'guess' });
  });
});

describe('searchShapes', () => {
  const names = { tv: 'TV', monitor: 'Monitor', fridge: 'Fridge', device: 'Small device' };

  it('finds a shape by its name, then by its words in any language', () => {
    expect(searchShapes('tv', names)[0]).toBe('tv');
    expect(searchShapes('fern', names)).toContain('tv');
    expect(searchShapes('télé', names)).toContain('tv');
    expect(searchShapes('تلفاز', names)).toContain('tv');
    expect(searchShapes('kühl', names)).toEqual(['fridge']);
    expect(searchShapes('webcam', names)).toEqual(['device']);
    expect(searchShapes('router', names)).toEqual(['device']);
  });

  it('ranks the reader’s own names first', () => {
    expect(searchShapes('mon', { ...names, monitor: 'Monitor' })[0]).toBe('monitor');
  });

  it('is every shape when empty, and nothing for nonsense', () => {
    expect(searchShapes('  ', names)).toEqual(MAP_MODEL_KEYS);
    expect(searchShapes('zzqx', names)).toEqual([]);
  });
});
