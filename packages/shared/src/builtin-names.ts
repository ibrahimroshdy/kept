/**
 * The built-in library's names in French, German and Italian (D204). English and Arabic stay
 * beside each definition in builtin-types.ts; these three live here so that file keeps its shape.
 * The test checks every built-in type and field has all three.
 */
import { BUILTIN_TYPES, builtinType } from './builtin-types.js';

export type BuiltinNameLocale = 'en' | 'ar' | 'fr' | 'de' | 'it';
type More = { readonly fr: string; readonly de: string; readonly it: string };

export const BUILTIN_TYPE_NAMES_MORE: Readonly<Record<string, More>> = {
  device: { fr: 'Appareil', de: 'Gerät', it: 'Dispositivo' },
  furniture: { fr: 'Meubles', de: 'Möbel', it: 'Mobili' },
  appliance: { fr: 'Électroménager', de: 'Haushaltsgerät', it: 'Elettrodomestico' },
  large_appliance: { fr: 'Gros électroménager', de: 'Großgerät', it: 'Grande elettrodomestico' },
  small_appliance: { fr: 'Petit électroménager', de: 'Kleingerät', it: 'Piccolo elettrodomestico' },
  electronics: { fr: 'Électronique', de: 'Elektronik', it: 'Elettronica' },
  phone: { fr: 'Téléphone', de: 'Telefon', it: 'Telefono' },
  tablet: { fr: 'Tablette', de: 'Tablet', it: 'Tablet' },
  computer: { fr: 'Ordinateur', de: 'Computer', it: 'Computer' },
  tv_display: { fr: 'TV / écran', de: 'TV / Bildschirm', it: 'TV / schermo' },
  network_device: { fr: 'Appareil réseau', de: 'Netzwerkgerät', it: 'Dispositivo di rete' },
  camera: { fr: 'Appareil photo', de: 'Kamera', it: 'Fotocamera' },
  console: { fr: 'Console de jeux', de: 'Spielkonsole', it: 'Console' },
  cable: { fr: 'Câble', de: 'Kabel', it: 'Cavo' },
  charger: {
    fr: 'Chargeur / alimentation',
    de: 'Ladegerät / Netzteil',
    it: 'Caricatore / alimentatore',
  },
  tool: { fr: 'Outil', de: 'Werkzeug', it: 'Attrezzo' },
  power_tool: { fr: 'Outil électrique', de: 'Elektrowerkzeug', it: 'Elettroutensile' },
  box_bin: { fr: 'Boîte / bac', de: 'Kiste / Box', it: 'Scatola / contenitore' },
  safe: { fr: 'Coffre-fort', de: 'Tresor', it: 'Cassaforte' },
  vehicle: { fr: 'Véhicule', de: 'Fahrzeug', it: 'Veicolo' },
  car: { fr: 'Voiture', de: 'Auto', it: 'Auto' },
  motorbike: { fr: 'Moto', de: 'Motorrad', it: 'Moto' },
  bicycle: { fr: 'Vélo', de: 'Fahrrad', it: 'Bicicletta' },
  generator: { fr: 'Groupe électrogène', de: 'Stromerzeuger', it: 'Generatore' },
  safety_equipment: {
    fr: 'Équipement de sécurité',
    de: 'Sicherheitsausrüstung',
    it: 'Dispositivi di sicurezza',
  },
  fire_extinguisher: { fr: 'Extincteur', de: 'Feuerlöscher', it: 'Estintore' },
  first_aid_kit: { fr: 'Trousse de secours', de: 'Erste-Hilfe-Set', it: 'Kit di pronto soccorso' },
  smoke_detector: { fr: 'Détecteur de fumée', de: 'Rauchmelder', it: 'Rilevatore di fumo' },
  child_car_seat: { fr: 'Siège auto enfant', de: 'Kindersitz', it: 'Seggiolino auto' },
  valuables: { fr: 'Objets de valeur', de: 'Wertsachen', it: 'Oggetti di valore' },
  collectible: { fr: 'Objet de collection', de: 'Sammlerstück', it: 'Oggetto da collezione' },
  consumables: { fr: 'Consommables', de: 'Verbrauchsmaterial', it: 'Materiali di consumo' },
  batteries: { fr: 'Piles', de: 'Batterien', it: 'Batterie' },
  filters: { fr: 'Filtres', de: 'Filter', it: 'Filtri' },
};

export const BUILTIN_FIELD_NAMES_MORE: Readonly<Record<string, More>> = {
  os: { fr: 'Système d’exploitation', de: 'Betriebssystem', it: 'Sistema operativo' },
  os_version: { fr: 'Version du système', de: 'Systemversion', it: 'Versione del sistema' },
  firmware: { fr: 'Firmware', de: 'Firmware', it: 'Firmware' },
  mac_address: { fr: 'Adresse MAC', de: 'MAC-Adresse', it: 'Indirizzo MAC' },
  linked_account: {
    fr: 'Compte lié ou identifiant',
    de: 'Verknüpftes Konto oder Login',
    it: 'Account collegato o login',
  },
  material: { fr: 'Matériau', de: 'Material', it: 'Materiale' },
  dimensions: { fr: 'Dimensions', de: 'Abmessungen', it: 'Dimensioni' },
  imei: { fr: 'IMEI', de: 'IMEI', it: 'IMEI' },
  imei_2: { fr: 'Second IMEI', de: 'Zweite IMEI', it: 'Secondo IMEI' },
  storage: { fr: 'Stockage', de: 'Speicher', it: 'Memoria' },
  cpu: { fr: 'CPU', de: 'CPU', it: 'CPU' },
  ram: { fr: 'RAM', de: 'RAM', it: 'RAM' },
  licence_key: { fr: 'Clé de licence', de: 'Lizenzschlüssel', it: 'Chiave di licenza' },
  screen_size: { fr: 'Taille de l’écran', de: 'Bildschirmgröße', it: 'Dimensioni schermo' },
  wifi_password: { fr: 'Mot de passe Wi-Fi', de: 'Wi-Fi-Passwort', it: 'Password Wi-Fi' },
  connector_a: { fr: 'Connecteur A', de: 'Stecker A', it: 'Connettore A' },
  connector_b: { fr: 'Connecteur B', de: 'Stecker B', it: 'Connettore B' },
  length: { fr: 'Longueur', de: 'Länge', it: 'Lunghezza' },
  wattage: { fr: 'Puissance', de: 'Leistung', it: 'Potenza' },
  connector: { fr: 'Connecteur', de: 'Stecker', it: 'Connettore' },
  voltage: { fr: 'Tension', de: 'Spannung', it: 'Tensione' },
  battery_platform: { fr: 'Système de batterie', de: 'Akkusystem', it: 'Piattaforma batteria' },
  combination: { fr: 'Combinaison', de: 'Kombination', it: 'Combinazione' },
  vin: { fr: 'VIN', de: 'VIN', it: 'VIN' },
  plate: { fr: 'Plaque d’immatriculation', de: 'Kennzeichen', it: 'Targa' },
  frame_number: { fr: 'Numéro de cadre', de: 'Rahmennummer', it: 'Numero di telaio' },
  appraisal_value: { fr: 'Valeur d’expertise', de: 'Schätzwert', it: 'Valore di stima' },
  appraisal_date: { fr: 'Date d’expertise', de: 'Datum der Schätzung', it: 'Data della stima' },
  edition: { fr: 'Édition', de: 'Ausgabe', it: 'Edizione' },
  condition_grade: {
    fr: 'État de conservation',
    de: 'Erhaltungsgrad',
    it: 'Stato di conservazione',
  },
  provenance_notes: {
    fr: 'Notes sur la provenance',
    de: 'Notizen zur Herkunft',
    it: 'Note sulla provenienza',
  },
  size: { fr: 'Format', de: 'Größe', it: 'Formato' },
  chemistry: { fr: 'Technologie', de: 'Zellchemie', it: 'Chimica' },
  fits: { fr: 'Compatible avec', de: 'Passend für', it: 'Compatibile con' },
};

/** Every built-in field's English and Arabic names by key (unique along any chain: first wins). */
const FIELD_NAMES: ReadonlyMap<string, { en: string; ar: string }> = (() => {
  const out = new Map<string, { en: string; ar: string }>();
  for (const t of BUILTIN_TYPES)
    for (const f of t.fields) if (!out.has(f.key)) out.set(f.key, f.names);
  return out;
})();

/** A built-in type's name in `locale`; undefined for a key that isn't built in. */
export function builtinTypeName(key: string, locale: BuiltinNameLocale): string | undefined {
  const names = builtinType(key)?.names;
  if (!names) return undefined;
  if (locale === 'en' || locale === 'ar') return names[locale];
  return BUILTIN_TYPE_NAMES_MORE[key]?.[locale] ?? names.en;
}

/** A built-in field's label in `locale`; undefined for a key that isn't built in. */
export function builtinFieldName(key: string, locale: BuiltinNameLocale): string | undefined {
  const names = FIELD_NAMES.get(key);
  if (!names) return undefined;
  if (locale === 'en' || locale === 'ar') return names[locale];
  return BUILTIN_FIELD_NAMES_MORE[key]?.[locale] ?? names.en;
}
