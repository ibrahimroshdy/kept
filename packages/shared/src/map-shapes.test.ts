import { describe, expect, it } from 'vitest';
import { MAP_MODEL_KEYS, MAP_MODELS, type MapModelKey, mapModel } from './map.js';
import {
  foldText,
  SHAPE_GROUP,
  SHAPE_GROUPS,
  SHAPE_WORD_LANGS,
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

describe('suggestShapes: everyday electronics (#130)', () => {
  it.each([
    ['4K webcam', 'webcam'],
    ['Logitech webcam', 'webcam'],
    ['Webcam', 'webcam'],
    ['Caméra web', 'webcam'],
    ['كاميرا ويب', 'webcam'],
    ['Canon camera', 'camera'],
    ['Kamera', 'camera'],
    ['caméra', 'camera'],
    ['Fotocamera Nikon', 'camera'],
    ['كاميرا', 'camera'],
    ['Wi-Fi router', 'router'],
    ['Routeur', 'router'],
    ['Bluetooth speaker', 'speaker'],
    ['Lautsprecher', 'speaker'],
    ['altoparlante', 'speaker'],
    ['سماعة', 'speaker'],
    ['Floorstanding speaker', 'floor_speaker'],
    ['Echo Dot', 'smart_speaker'],
    ['Barre de son', 'soundbar'],
    ['Kopfhörer', 'headphones'],
    ['cuffie Sony', 'headphones'],
    ['Logitech mouse', 'mouse'],
    ['Souris', 'mouse'],
    ['Tastatur', 'keyboard'],
    ['tastiera', 'keyboard'],
    ['لوحة مفاتيح', 'keyboard'],
    ['HP printer', 'printer'],
    ['Drucker', 'printer'],
    ['stampante', 'printer'],
    ['طابعة', 'printer'],
    ['PlayStation 5', 'console'],
    ['PS5 controller', 'controller'],
    ['يد تحكم PS5', 'controller'],
    ['iPhone 15', 'phone'],
    ['Handy', 'phone'],
    ['هاتف', 'phone'],
    ['iPad Air', 'tablet'],
    ['Tablette', 'tablet'],
    ['Steckdosenleiste', 'power_strip'],
    ['ciabatta', 'power_strip'],
    ['Samsung T7 SSD', 'external_drive'],
    ['Disque dur externe', 'external_drive'],
    ['Gaming PC', 'pc_tower'],
  ] as const)('%s gets the %s, given by itself', (name, model) => {
    const s = suggestShapes({ name });
    expect(s.shapes[0]).toMatchObject({ model, from: 'name' });
    expect(s.confident).toBe(true);
  });

  it('gives a webcam its own shape at a webcam’s size, not a box’s', () => {
    expect(shapeOnAdd({ name: '4K webcam' })).toEqual({ model: 'webcam', from: 'name' });
    const m = mapModel('webcam');
    expect(m.w).toBeLessThanOrEqual(0.15);
    expect(m.d).toBeLessThanOrEqual(0.1);
  });

  it('draws everyday things at their real sizes', () => {
    // [width, depth, height] in centimetres, within a fifth either way.
    const sizes: Record<string, [number, number, number]> = {
      mouse: [6.5, 11.5, 4],
      keyboard: [44, 14, 3],
      phone: [7.5, 15.5, 1],
      tablet: [25, 18, 1],
      soundbar: [90, 10, 7],
      floor_speaker: [20, 28, 100],
      printer: [43, 36, 20],
      pc_tower: [20, 43, 45],
    };
    for (const [key, [w, d, h]] of Object.entries(sizes)) {
      const m = mapModel(key as MapModelKey);
      expect(m.w * 100, key).toBeCloseTo(w, -0.7);
      expect(m.d * 100, key).toBeCloseTo(d, -0.7);
      expect((m.h ?? 0) * 100, key).toBeCloseTo(h, -0.7);
      expect(SHAPE_GROUP[key as MapModelKey], key).toBe('electronics');
    }
  });

  it('suggests from the type: a phone, a tablet and a console by itself, a camera ranked', () => {
    expect(shapeOnAdd({ name: 'Work', typeKey: 'phone' })).toEqual({
      model: 'phone',
      from: 'type',
    });
    expect(shapeOnAdd({ name: 'Kids', typeKey: 'tablet' })).toEqual({
      model: 'tablet',
      from: 'type',
    });
    expect(shapeOnAdd({ name: 'Living room', typeKey: 'console' })).toEqual({
      model: 'console',
      from: 'type',
    });
    const cam = suggestShapes({ name: 'Front door', typeKey: 'camera' });
    expect(cam.shapes.slice(0, 2).map((x) => x.model)).toEqual(['camera', 'webcam']);
    expect(cam.confident).toBe(false);
    expect(first({ name: 'Office', typeKey: 'network_device' })).toBe('router');
    // A webcam typed as a camera: the name settles it.
    expect(shapeOnAdd({ name: '4K webcam', typeKey: 'camera' })).toEqual({
      model: 'webcam',
      from: 'name',
    });
  });

  it('is not sure about an accessory: a case is not the phone it is for', () => {
    for (const name of ['Phone case', 'Laptop stand', 'Coque iPhone', 'Custodia tablet']) {
      const s = suggestShapes({ name });
      expect(s.confident, name).toBe(false);
    }
    expect(first({ name: 'Phone case' })).toBe('phone');
    expect(first({ name: 'Phone charger' })).toBe('device');
    expect(first({ name: 'TV remote' })).toBe('device');
    expect(sure({ name: 'TV remote' })).toBe(false);
    // Inside a shape's own phrase an accessory word is just a word.
    expect(shapeOnAdd({ name: 'TV stand' })).toEqual({ model: 'tv_stand', from: 'name' });
    expect(sure({ name: 'حامل تلفاز' })).toBe(true);
  });
});

describe('suggestShapes: things with no shape of their own', () => {
  it.each(['Thermostat', 'Raspberry Pi', 'Ladegerät', 'Video doorbell', 'كاشف دخان'])(
    '%s gets the small device, suggested but not given by itself',
    (name) => {
      const s = suggestShapes({ name });
      expect(s.shapes[0]?.model).toBe('device');
      expect(s.shapes[0]?.from).toBe('name');
      expect(s.confident).toBe(false);
    },
  );

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
    expect(shapeOnAdd({ name: 'Logitech webcam' })).toEqual({ model: 'webcam', from: 'name' });
    expect(shapeOnAdd({ name: 'Thermostat' })).toEqual({ model: 'device', from: 'guess' });
    expect(shapeOnAdd({ name: 'Screen' })).toEqual({ model: 'tv', from: 'guess' });
  });
});

describe('searchShapes', () => {
  const names = {
    tv: 'TV',
    monitor: 'Monitor',
    fridge: 'Fridge',
    device: 'Small device',
    car: 'Car',
    camera: 'Camera',
    webcam: 'Webcam',
    tool_cart: 'Tool cart',
    watering_can: 'Watering can',
    cabinet: 'Filing cabinet',
    succulent: 'Succulent',
    keyboard: 'Keyboard',
  };
  const before = (list: string[], a: string, b: string) =>
    expect(list.indexOf(a), `${a} before ${b} in ${list.join(', ')}`).toBeLessThan(
      list.indexOf(b) < 0 ? Number.POSITIVE_INFINITY : list.indexOf(b),
    );

  it('finds a shape by its name, then by its words in any language', () => {
    expect(searchShapes('tv', names)[0]).toBe('tv');
    expect(searchShapes('fern', names)).toContain('tv');
    expect(searchShapes('télé', names)).toContain('tv');
    expect(searchShapes('تلفاز', names)).toContain('tv');
    expect(searchShapes('kühl', names)).toEqual(['fridge']);
    expect(searchShapes('webcam', names)).toEqual(['webcam']);
    expect(searchShapes('router', names)[0]).toBe('router');
  });

  it('ranks the reader’s own names first', () => {
    expect(searchShapes('mon', { ...names, monitor: 'Monitor' })[0]).toBe('monitor');
  });

  it('puts word starts and synonyms before later words: “Ca” finds Camera and Webcam first', () => {
    for (const q of ['Ca', 'ca', 'cam']) {
      const found = searchShapes(q, names);
      for (const m of ['camera', 'webcam']) {
        expect(found, q).toContain(m);
        before(found, m, 'tool_cart');
        before(found, m, 'watering_can');
        before(found, m, 'cabinet');
      }
    }
    expect(searchShapes('ca', names).slice(0, 3)).toEqual(['car', 'camera', 'webcam']);
    // "cam" is a webcam's own word, whole.
    expect(searchShapes('cam', names).slice(0, 2)).toEqual(['webcam', 'camera']);
  });

  it('matches inside a word only from three letters, or when nothing else matches', () => {
    // "ca" is inside "bookcase": two letters never find the bookshelf, three do.
    expect(searchShapes('ca', names)).not.toContain('bookshelf');
    expect(searchShapes('cas', names)).toContain('bookshelf');
    // Nothing starts with "ul": then inside a word counts (Succulent).
    expect(searchShapes('ul', names)[0]).toBe('succulent');
  });

  it('reads the reader’s language and English by word starts, the others by whole words', () => {
    // English: Car, Camera and Webcam first; nothing for canapé, cassa, caisse, casque or cage.
    const en = searchShapes('ca', names, 'en');
    expect(en.slice(0, 3)).toEqual(['car', 'camera', 'webcam']);
    for (const m of ['sofa', 'speaker', 'floor_speaker', 'crate', 'headphones', 'stairwell'])
      expect(en, m).not.toContain(m);
    expect(searchShapes('cam', names, 'en')).toEqual(['webcam', 'camera']);
    // French: "ca" finds the sofa by "canapé", its French name first.
    const fr = { sofa: 'Canapé', car: 'Voiture', camera: 'Appareil photo', webcam: 'Webcam' };
    expect(searchShapes('ca', fr, 'fr')[0]).toBe('sofa');
    expect(searchShapes('ca', fr, 'fr')).toContain('headphones');
    // Italian and German by their own starts.
    expect(searchShapes('cuff', {}, 'it')[0]).toBe('headphones');
    expect(searchShapes('tast', {}, 'de')[0]).toBe('keyboard');
    // A whole word in another language still finds its shape: Kühlschrank in English.
    expect(searchShapes('Kühlschrank', names, 'en')[0]).toBe('fridge');
    // And when the reader's language finds nothing, the others' starts count: "kühl".
    expect(searchShapes('kühl', names, 'en')).toEqual(['fridge']);
    // Arabic is its own: "كام" finds the camera and the webcam for an Arabic reader.
    expect(searchShapes('كام', {}, 'ar').slice(0, 2).sort()).toEqual(['camera', 'webcam']);
  });

  it('lists only real words as French, German or Italian', () => {
    const all = new Set(MAP_MODEL_KEYS.flatMap((k) => SHAPE_WORDS[k]));
    for (const [lang, ws] of Object.entries(SHAPE_WORD_LANGS))
      for (const w of ws) expect(all.has(w), `${lang}: ${w}`).toBe(true);
  });

  it('ranks word starts and synonyms in all five languages', () => {
    // English, French, German, Italian, Arabic, each by its own word's start.
    expect(searchShapes('keyb', names)[0]).toBe('keyboard');
    expect(searchShapes('clav', {}, 'fr')[0]).toBe('keyboard');
    expect(searchShapes('tast', {}, 'de')[0]).toBe('keyboard');
    expect(searchShapes('cuff', {}, 'it')[0]).toBe('headphones');
    expect(searchShapes('لوحة مف', {}, 'ar')[0]).toBe('keyboard');
    expect(searchShapes('سماعة ر', {}, 'ar')[0]).toBe('headphones');
    // A later word's start in a phrase: "barre de son" for "son".
    expect(searchShapes('son', {}, 'fr')).toContain('soundbar');
    // A whole word beats a longer word that starts with it: "pc" is the PC, not "pc portable".
    expect(searchShapes('pc', names)[0]).toBe('pc_tower');
  });

  it('is every shape when empty, and nothing for nonsense', () => {
    expect(searchShapes('  ', names)).toEqual(MAP_MODEL_KEYS);
    expect(searchShapes('zzqx', names)).toEqual([]);
  });
});
