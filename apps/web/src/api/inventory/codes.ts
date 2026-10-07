/**
 * Own codes (D208; engineering spec §7.16, plan T17a): the household's own identifiers on a thing
 * or a place (an existing asset sticker, `HOME-0042`), and a location's numbering and format
 * rule. The server is apps/server/src/codes/.
 *
 * Writes answer `X-Kept-Audit-Event` (`thing.codes` / `place.codes`), so each offers Undo.
 * Refusals: 409 `conflict` with `{taken: {kind, id}}` for a code the location already has (under
 * any source); 400 `validation` with the rule's own message as the hint and `{rule: {message,
 * example}, reason}` for a code the format rule refuses; 400 `validation` with `{reason:
 * 'invalid' | 'slow' | 'example' | 'numbering'}` for options that can't be set.
 */
import { useQuery } from '@tanstack/react-query';
import { api, ifMatch, requestWritten } from '../client';

const V1 = '/api/v1';
const seg = (value: string) => encodeURIComponent(value);

export type CodeTargetKind = 'thing' | 'place';

export const codePaths = {
  codes: (kind: CodeTargetKind, id: string) => `${V1}/${kind}s/${seg(id)}/codes`,
  code: (kind: CodeTargetKind, id: string, code: string) =>
    `${V1}/${kind}s/${seg(id)}/codes/${seg(code)}`,
  settings: (locationId: string) => `${V1}/locations/${seg(locationId)}/own-codes`,
  mismatches: (locationId: string) => `${V1}/locations/${seg(locationId)}/own-codes/mismatches`,
};

export type TargetCode = {
  code: string;
  /** `own` codes are the household's and editable; `csv` and `homebox` came with an import. */
  source: 'own' | 'csv' | 'homebox' | (string & {});
  sourceCollection: string;
};
export type TargetCodes = { codes: TargetCode[] };

export type FormatRule = { pattern: string; message: string; example: string };

export type OwnCodeSettings = {
  locationId: string;
  numbering: { enabled: boolean; prefix: string; pad: number; next: string };
  rule: FormatRule | null;
  /** 0 before the options were first saved: sent back as If-Match. */
  rowVersion: number;
};

export type OwnCodeSettingsBody = {
  numbering: { enabled: boolean; prefix: string; pad: number };
  rule: FormatRule | null;
};

export type CodeMismatch = {
  code: string;
  kind: CodeTargetKind;
  id: string;
  name: string;
  reason: 'mismatch' | 'slow';
};
export type CodeMismatches = { rule: FormatRule | null; items: CodeMismatch[] };

/** The details of a refused code: a rule's example, or what already has it. */
export type CodeRefusal = {
  rule?: { message: string; example: string };
  reason?: string;
  taken?: { kind: CodeTargetKind; id: string };
  next?: string;
};

export const codeKeys = {
  all: ['codes'] as const,
  target: (kind: CodeTargetKind, id: string) => ['codes', kind, id] as const,
  settings: (locationId: string) => ['codes', 'settings', locationId] as const,
  mismatches: (locationId: string) => ['codes', 'mismatches', locationId] as const,
};

export const codeApi = {
  list: (kind: CodeTargetKind, id: string) => api.get<TargetCodes>(codePaths.codes(kind, id)),
  add: (kind: CodeTargetKind, id: string, body: { code: string } | { next: true }) =>
    requestWritten<{ code: string }>(codePaths.codes(kind, id), { method: 'POST', body }),
  rename: (kind: CodeTargetKind, id: string, code: string, to: string) =>
    requestWritten<{ code: string }>(codePaths.code(kind, id, code), {
      method: 'PUT',
      body: { code: to },
    }),
  remove: (kind: CodeTargetKind, id: string, code: string) =>
    requestWritten<void>(codePaths.code(kind, id, code), { method: 'DELETE' }),
  settings: (locationId: string) => api.get<OwnCodeSettings>(codePaths.settings(locationId)),
  saveSettings: (locationId: string, body: OwnCodeSettingsBody, rowVersion: number) =>
    api.put<OwnCodeSettings>(codePaths.settings(locationId), body, ifMatch(rowVersion)),
  mismatches: (locationId: string) => api.get<CodeMismatches>(codePaths.mismatches(locationId)),
};

export const useTargetCodes = (kind: CodeTargetKind, id: string) =>
  useQuery({ queryKey: codeKeys.target(kind, id), queryFn: () => codeApi.list(kind, id) });

export const useOwnCodeSettings = (locationId: string) =>
  useQuery({
    queryKey: codeKeys.settings(locationId),
    queryFn: () => codeApi.settings(locationId),
    enabled: locationId !== '',
  });

export const useCodeMismatches = (locationId: string, enabled = true) =>
  useQuery({
    queryKey: codeKeys.mismatches(locationId),
    queryFn: () => codeApi.mismatches(locationId),
    enabled: enabled && locationId !== '',
  });
