/**
 * Lend (D57, screens §5): to a member or a contact (members first, "+ New person"), part of a
 * quantity (the lent part becomes its own row, D10, and merges back on return, Q14), an optional
 * due date, a note and condition photos. Kept never messages the person; it reminds you when the
 * loan is overdue. Lending is a create, so it has no Undo (§7.7): "Mark returned" ends it, and
 * Remove on the loan takes back one recorded by mistake.
 *
 * With Lending off here, the sheet says so (screens §3) instead of the form.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { householdApi } from '@/api/household/queries';
import type { LendBody } from '@/api/household/types';
import { useErrorText } from '@/components/page';
import { ModuleOff, useThingCtx } from '@/components/things/context';
import { westernNumber } from '@/components/things/form-model';
import { todayIn, useBlocked, useHouseholdDone } from '@/components/things/household';
import { PendingFiles, useAttachAll } from '@/components/things/pending-files';
import { useLocationAccountId } from '@/components/things/pickers';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { isolate } from '@/lib/bidi';
import { useFormat } from '@/lib/format';
import {
  emptyPerson,
  PersonPicker,
  type PersonValue,
  personInput,
  usePersonOptions,
} from './person-picker';

export function LendSheet({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { thing, moduleOn } = useThingCtx();
  const { t } = useLingui();
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t`Lend ${thing.name ?? ''}`}
    >
      {moduleOn('lending') ? (
        isOpen ? (
          <LendForm onClose={onClose} />
        ) : null
      ) : (
        <div className="grid gap-3.5">
          <ModuleOff what={<Trans>Lending</Trans>} />
          <DialogFooter>
            <Button variant="secondary" onPress={onClose}>
              <Trans>Close</Trans>
            </Button>
          </DialogFooter>
        </div>
      )}
    </Sheet>
  );
}

function LendForm({ onClose }: { onClose: () => void }) {
  const { thing, location, can } = useThingCtx();
  const { t } = useLingui();
  const fmt = useFormat();
  const errorText = useErrorText();
  const done = useHouseholdDone();
  const attachAll = useAttachAll();
  const blocked = useBlocked();
  const accountId = useLocationAccountId(location);
  const options = usePersonOptions(location.id, accountId);
  const today = todayIn(location.timezone);
  const [person, setPerson] = useState<PersonValue>(emptyPerson);
  const [count, setCount] = useState(String(thing.quantity));
  const [dueOn, setDueOn] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<{ field: 'person' | 'count' | 'form'; text: string }>();
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const who = personInput(person, options);
    if (!who) {
      setError({ field: 'person', text: t`Who is it going to?` });
      return;
    }
    const body: LendBody = { person: who };
    if (thing.quantity > 1) {
      const n = Number(westernNumber(count).trim());
      if (!Number.isInteger(n) || n < 1 || n > thing.quantity) {
        setError({ field: 'count', text: t`Between 1 and ${fmt.num(thing.quantity)}.` });
        return;
      }
      if (n < thing.quantity) body.quantity = String(n);
    }
    if (dueOn) body.dueOn = dueOn;
    if (notes.trim()) body.notes = notes.trim();
    setBusy(true);
    try {
      const r = await householdApi.lend(thing.id, body);
      await attachAll(files, thing.locationId, { loanId: r.loan.id }, 'condition_out');
      toast({ title: t`Lent to ${isolate(r.loan.person.name)}`, tone: 'ok' });
      await done();
      onClose();
    } catch (e) {
      setError({ field: 'form', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      noValidate
      className="grid gap-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <PersonPicker
        label={t`Lend to`}
        options={options}
        value={person}
        onChange={(v) => {
          setPerson(v);
          setError(undefined);
        }}
        errorMessage={error?.field === 'person' ? error.text : undefined}
      />
      {thing.quantity > 1 ? (
        <TextField
          label={t`How many`}
          description={t`Of ${fmt.num(thing.quantity)}. Lending some splits them off; they merge back when returned.`}
          value={count}
          onChange={(v) => {
            setCount(v);
            setError(undefined);
          }}
          inputProps={{ inputMode: 'numeric', dir: 'ltr' }}
          {...(error?.field === 'count' ? { errorMessage: error.text, isInvalid: true } : {})}
        />
      ) : null}
      <DatePicker
        label={t`Due back`}
        description={t`Optional. Kept reminds you, never them, when it's overdue.`}
        value={dueOn}
        onChange={setDueOn}
        minValue={today}
      />
      <TextField label={t`Note`} value={notes} onChange={setNotes} inputProps={{ dir: 'auto' }} />
      {can('attachments.add') ? (
        <PendingFiles
          files={files}
          onChange={setFiles}
          label={t`Condition photos`}
          accept={['image/*']}
        />
      ) : null}
      {error?.field === 'form' ? (
        <p role="alert" className="m-0 text-small text-danger">
          {error.text}
        </p>
      ) : null}
      {blocked ? <p className="m-0 text-small text-ink-3">{blocked}</p> : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={busy} isDisabled={!!blocked}>
          <Trans>Lend</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
