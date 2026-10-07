/**
 * Delete a location (D149; plan T21): the owner's sheet, and the first web caller of
 * `deleteLocation`. Export first (optional), then the location's name typed exactly, then the
 * 30-day grace: the location stays restorable for 30 days, then it's gone with its files. Personal
 * can't be deleted (the server answers 409), so it has no sheet.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { deleteLocation } from '@/api/locations';
import { keys } from '@/api/queries';
import type { LocationDetail } from '@/api/types';
import { Notice, Section, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter, Modal } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { isolate } from '@/lib/bidi';
import { useLocationName } from '@/lib/labels';
import { useOnline } from '@/lib/online';
import { ExportFirst } from './export-first';

/** Location settings → General's last section: the owner's Delete, opening the sheet. */
export function DeleteLocationSection({ location }: { location: LocationDetail }) {
  const [open, setOpen] = useState(false);
  const online = useOnline();
  const locationName = useLocationName();
  if (location.role !== 'owner' || location.kind === 'personal') return null;
  const name = locationName(location);
  return (
    <Section title={<Trans>Delete</Trans>}>
      <div className="grid gap-2 rounded-[10px] border border-line bg-surface p-3.5">
        <p className="m-0 text-small text-ink-2">
          <Trans>
            Deleting <bdi>{name}</bdi> removes it for everyone in it. It stays restorable for 30
            days.
          </Trans>
        </p>
        <Button
          variant="danger"
          className="justify-self-start"
          isDisabled={!online}
          onPress={() => setOpen(true)}
        >
          <Trans>
            Delete <bdi>{name}</bdi>…
          </Trans>
        </Button>
      </div>
      {open ? (
        <DeleteLocationSheet location={location} name={name} onClose={() => setOpen(false)} />
      ) : null}
    </Section>
  );
}

export function DeleteLocationSheet({
  location,
  name,
  onClose,
}: {
  location: LocationDetail;
  name: string;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const online = useOnline();
  const errorText = useErrorText();
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === name.trim();
  const remove = useMutation({
    mutationFn: () => deleteLocation(location.id),
    onSuccess: async () => {
      onClose();
      await qc.invalidateQueries({ queryKey: keys.locations });
      toast({
        title: t`Deleted ${isolate(name)}. It can be restored for 30 days.`,
        tone: 'ok',
      });
      void navigate({ to: '/' });
    },
  });

  return (
    <Modal isOpen onOpenChange={(o) => !o && onClose()}>
      <Dialog
        title={
          <Trans>
            Delete <bdi>{name}</bdi>?
          </Trans>
        }
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (matches && online) remove.mutate();
          }}
        >
          <ExportFirst locationId={location.id} name={name} />
          <TextField
            label={t`Type ${name} to confirm`}
            value={typed}
            onChange={setTyped}
            autoComplete="off"
            isInvalid={typed.trim() !== '' && !matches}
            errorMessage={t`That isn't the location's name.`}
          />
          <p className="m-0 text-small text-ink-2">
            <Trans>
              <bdi>{name}</bdi> stays restorable for 30 days, then it's gone with its files.
            </Trans>
          </p>
          {remove.isError ? (
            <Notice tone="danger" title={<Trans>That didn't work</Trans>}>
              {errorText(remove.error)}
            </Notice>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" onPress={onClose}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              type="submit"
              variant="danger"
              isDisabled={!matches || !online}
              isPending={remove.isPending}
            >
              <Trans>
                Delete <bdi>{name}</bdi>
              </Trans>
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </Modal>
  );
}
