/**
 * The mock's semantic search (step 6 T14's twin, for T24): a few queries that only meaning finds,
 * as the server's mock embedder finds them in the seed ("the thing for the TV" → the HDMI cable;
 * "شاحن الموبايل" → the phone charger), and the state the search answer reports when meaning
 * wasn't searched. Kept beside the scenario in a WeakMap so no other state type changes; a test
 * sets `semanticMock(state).state` to see a note.
 */
import { normalize } from '@kept/shared';
import type { MockState } from '../../mock/fixtures';
import type { SemanticState } from '../types';
import { INV_IDS } from './fixtures';

export type SemanticMock = {
  /** Null: meaning was searched too. */
  state: SemanticState | null;
  /** A normalised query → the things only meaning finds, best first. */
  meaning: Record<string, string[]>;
};

const T = INV_IDS.thing;
const store = new WeakMap<MockState, SemanticMock>();

export function semanticMock(state: MockState): SemanticMock {
  let s = store.get(state);
  if (!s) {
    s = {
      state: null,
      meaning: {
        [normalize('the thing for the TV')]: [T.hdmiCable, T.cableBox],
        [normalize('شاحن الموبايل')]: [T.arCharger],
      },
    };
    store.set(state, s);
  }
  return s;
}

/** The things only meaning finds for `q`, or none when meaning wasn't searched. */
export function meaningOnly(state: MockState, q: string): string[] {
  const s = semanticMock(state);
  if (s.state || !q) return [];
  return s.meaning[normalize(q)] ?? [];
}
