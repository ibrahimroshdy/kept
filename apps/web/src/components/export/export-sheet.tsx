/**
 * Start an export (plan T21; D68, D69, D159; Q7, Q14, Q17): a location you own or administer, or
 * your own data ("Export my data": the Personal location, your profile and preferences, and your
 * own AI calls). What goes in besides the things: ended things, the Trash, the history, the AI
 * calls, and a copy readable without Kept (HTML, CSVs, thumbnails) with the inventory PDF, in a
 * language and digits of its own. "Include secrets" is the owner's: encrypted with a passphrase
 * given twice, with the warning that Kept can't recover it. The readable copy never holds them.
 *
 * Exports need a connection (screens §4): offline, Export is disabled with the reason.
 */
import { newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { portabilityApi, portabilityKeys } from '@/api/portability/queries';
import type { ExportOptions, ExportRun } from '@/api/portability/types';
import type { LocationSummary } from '@/api/types';
import { LanguageSelect } from '@/components/languages';
import { Notice } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogFooter, Modal } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { type Digits, type Locale, usePrefs } from '@/lib/prefs';
import { useExportErrorText } from './labels';
import { type Passphrase, PassphraseFields, passphraseReady } from './passphrase-field';

export type ExportScopeChoice = { me: true } | { locationId: string };

export function ExportSheet({
  isOpen,
  onClose,
  scope,
  locations,
  options: startOptions,
  onStarted,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** "Export my data", or a location (the picker starts on it). */
  scope: ExportScopeChoice;
  /** The locations the caller may export: owner or admin, not Personal. */
  locations: LocationSummary[];
  /** Another export's options, for "Export again". */
  options?: Partial<ExportOptions>;
  onStarted?: (run: ExportRun) => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const online = useOnline();
  const prefs = usePrefs();
  const locationName = useLocationName();
  const errorText = useExportErrorText();
  const me = 'me' in scope;
  const [locationId, setLocationId] = useState(
    'locationId' in scope ? scope.locationId : (locations[0]?.id ?? ''),
  );
  const [options, setOptions] = useState<ExportOptions>({
    ended: true,
    trashed: false,
    history: true,
    aiCalls: true,
    readable: true,
    pdf: true,
    locale: prefs.locale,
    digits: prefs.digits,
    ...startOptions,
  });
  const [secrets, setSecrets] = useState(false);
  const [pass, setPass] = useState<Passphrase>({ first: '', again: '' });
  const [failure, setFailure] = useState<string | null>(null);
  const location = locations.find((l) => l.id === locationId);
  const isOwner = location?.role === 'owner';
  const withSecrets = !me && isOwner && secrets;
  const set = (patch: Partial<ExportOptions>) => setOptions((o) => ({ ...o, ...patch }));

  const start = useMutation({
    mutationFn: () =>
      portabilityApi.createExport({
        id: newId(),
        scope: me ? { me: true } : { locationId },
        options,
        ...(withSecrets
          ? { includeSecrets: true, passphrase: pass.first, passphraseAgain: pass.again }
          : {}),
      }),
    onSuccess: (run) => {
      setPass({ first: '', again: '' });
      setFailure(null);
      void qc.invalidateQueries({ queryKey: portabilityKeys.exports.all });
      onStarted?.(run);
      onClose();
    },
    onError: (e) => setFailure(errorText(e)),
  });

  const name = location ? locationName(location) : '';
  const ready =
    online && (me || !!location) && (!withSecrets || passphraseReady(pass)) && !start.isPending;

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          setPass({ first: '', again: '' });
          onClose();
        }
      }}
      className="max-w-lg"
    >
      <Dialog title={me ? t`Export my data` : t`Export a location`}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) start.mutate();
          }}
        >
          {me ? (
            <p className="m-0 text-small text-ink-2">
              <Trans>
                Your Personal location with its files, your profile and preferences, and the AI
                calls you made. Locations you own are exported one by one.
              </Trans>
            </p>
          ) : (
            <Combobox
              label={t`Location`}
              items={locations.map((l) => ({ id: l.id, label: locationName(l) }))}
              selectedKey={locationId || null}
              onSelectionChange={(k) => {
                if (!k) return;
                setLocationId(String(k));
                setSecrets(false);
              }}
            />
          )}

          <fieldset className="m-0 grid gap-1 border-0 p-0">
            <legend className="mb-1 p-0 font-semibold text-[15px]">
              <Trans>What goes in</Trans>
            </legend>
            <p className="m-0 mb-1 text-small text-ink-2">
              <Trans>Every thing, place, photo and document is always in it.</Trans>
            </p>
            <Switch isSelected={options.ended} onChange={(ended) => set({ ended })}>
              <Trans>Ended things (sold, given away, thrown out)</Trans>
            </Switch>
            <Switch isSelected={options.trashed} onChange={(trashed) => set({ trashed })}>
              <Trans>Things in the Trash</Trans>
            </Switch>
            <Switch isSelected={options.history} onChange={(history) => set({ history })}>
              <Trans>History</Trans>
            </Switch>
            <Switch isSelected={options.aiCalls} onChange={(aiCalls) => set({ aiCalls })}>
              <Trans>AI calls</Trans>
            </Switch>
            <Switch
              isSelected={options.readable}
              onChange={(readable) => set({ readable, ...(readable ? {} : { pdf: false }) })}
            >
              <Trans>A copy you can read without Kept</Trans>
            </Switch>
            <Switch
              isSelected={options.readable && options.pdf}
              isDisabled={!options.readable}
              onChange={(pdf) => set({ pdf })}
              className="ms-6"
            >
              <Trans>with the inventory PDF</Trans>
            </Switch>
          </fieldset>

          {options.readable ? (
            <div className="grid gap-3">
              <LanguageSelect
                label={t`The readable copy's language`}
                value={(options.locale as Locale) ?? 'en'}
                onChange={(locale) => set({ locale })}
              />
              {options.locale === 'ar' ? (
                <Segmented<Digits>
                  label={t`Its digits`}
                  value={options.digits}
                  onChange={(digits) => set({ digits })}
                  options={[
                    { id: 'western', label: <span className="ltr">0123</span> },
                    { id: 'eastern', label: <span lang="ar">٠١٢٣</span> },
                  ]}
                />
              ) : null}
            </div>
          ) : null}

          {!me && isOwner ? (
            <div className="grid gap-3 rounded-[10px] border border-line p-3.5">
              <Switch isSelected={secrets} onChange={setSecrets}>
                <Trans>Include secrets</Trans>
              </Switch>
              <p className="m-0 -mt-2 text-small text-ink-2">
                <Trans>
                  Encrypted with a passphrase you choose. The readable copy never holds them.
                </Trans>
              </p>
              {secrets ? (
                <>
                  <PassphraseFields value={pass} onChange={setPass} />
                  <Notice tone="warn">
                    <Trans>
                      Anyone with this file and the passphrase can read every secret in it. Kept
                      can't recover a forgotten passphrase.
                    </Trans>
                  </Notice>
                </>
              ) : null}
            </div>
          ) : null}

          {failure ? (
            <Notice tone="danger" title={<Trans>That didn't work</Trans>}>
              {failure}
            </Notice>
          ) : null}
          {!online ? <Notice tone="warn" title={<Trans>Needs a connection</Trans>} /> : null}

          <DialogFooter>
            <Button variant="secondary" onPress={onClose}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" isDisabled={!ready} isPending={start.isPending}>
              {me ? (
                <Trans>Export my data</Trans>
              ) : (
                <Trans>
                  Export <bdi>{name}</bdi>
                </Trans>
              )}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </Modal>
  );
}
