/**
 * Borrow (D56): a thing someone lent you, added to this location as theirs ("belongs to"), with
 * a loan in and an optional due date, so the neighbour's ladder gets the same reminder as your
 * drill. It lives in your inventory while it's here; "Mark returned" gives it back and it leaves
 * your counts. Reached from the location's "Add here" (T20); the Lending screen reuses it.
 */
import { newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { householdApi } from '@/api/household/queries';
import type { BorrowBody } from '@/api/household/types';
import type { MoveTarget } from '@/api/inventory/types';
import { useLocation } from '@/api/queries';
import { useErrorText } from '@/components/page';
import { useInvalidateHousehold } from '@/components/schedules/access';
import { todayIn } from '@/components/things/household';
import {
  isChosen,
  TypePicker,
  useLocationAccountId,
  WherePicker,
  type WhereValue,
} from '@/components/things/pickers';
import { Sheet } from '@/components/things/sheet';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { isolate } from '@/lib/bidi';
import { useOnline } from '@/lib/online';
import {
  emptyPerson,
  PersonPicker,
  type PersonValue,
  personInput,
  usePersonOptions,
} from './person-picker';

export function BorrowSheet({
  isOpen,
  onClose,
  locationId,
  target,
}: {
  isOpen: boolean;
  onClose: () => void;
  locationId: string;
  /** Where it goes by default (the location's Unplaced area, or the place you're on). */
  target: MoveTarget;
}) {
  const { t } = useLingui();
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t`A borrowed thing`}
    >
      {isOpen ? <BorrowForm locationId={locationId} target={target} onClose={onClose} /> : null}
    </Sheet>
  );
}

function BorrowForm({
  locationId,
  target,
  onClose,
}: {
  locationId: string;
  target: MoveTarget;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const invalidate = useInvalidateHousehold();
  const online = useOnline();
  const location = useLocation(locationId);
  const accountId = useLocationAccountId(location.data);
  const options = usePersonOptions(locationId, accountId);
  const today = todayIn(location.data?.timezone);
  const [name, setName] = useState('');
  const [typeId, setTypeId] = useState<string | null>(null);
  const [person, setPerson] = useState<PersonValue>(emptyPerson);
  const [where, setWhere] = useState<WhereValue>({ locationId, target });
  const [dueOn, setDueOn] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<{ field: 'name' | 'person' | 'form'; text: string }>();
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) {
      setError({ field: 'name', text: t`What is it called?` });
      return;
    }
    const who = personInput(person, options);
    if (!who) {
      setError({ field: 'person', text: t`Who lent it to you?` });
      return;
    }
    if (!isChosen(where.target)) {
      setError({ field: 'form', text: t`Choose where it is.` });
      return;
    }
    const body: BorrowBody = {
      thingId: newId(),
      name: name.trim(),
      target: where.target,
      person: who,
      ...(typeId ? { typeId } : {}),
      ...(dueOn ? { dueOn } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    setBusy(true);
    try {
      const r = await householdApi.borrow(locationId, body);
      await invalidate();
      onClose();
      toast({
        title: t`Borrowed from ${isolate(r.loan.person.name)}`,
        tone: 'ok',
        action: {
          label: t`Open`,
          onAction: () => void navigate({ to: '/t/$id', params: { id: r.thing.id } }),
        },
      });
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
      <TextField
        label={t`Name`}
        value={name}
        onChange={(v) => {
          setName(v);
          setError(undefined);
        }}
        autoFocus
        inputProps={{ dir: 'auto' }}
        {...(error?.field === 'name' ? { errorMessage: error.text, isInvalid: true } : {})}
      />
      <PersonPicker
        label={t`Borrowed from`}
        options={options}
        value={person}
        onChange={(v) => {
          setPerson(v);
          setError(undefined);
        }}
        errorMessage={error?.field === 'person' ? error.text : undefined}
      />
      <TypePicker
        accountId={accountId}
        label={t`Type (optional)`}
        value={typeId}
        onChange={(id) => setTypeId(id)}
      />
      <WherePicker value={where} onChange={setWhere} allowOtherLocations={false} />
      <DatePicker
        label={t`Due back`}
        description={t`Optional. Kept reminds you when it's due back.`}
        value={dueOn}
        onChange={setDueOn}
        minValue={today}
      />
      <TextField label={t`Note`} value={notes} onChange={setNotes} inputProps={{ dir: 'auto' }} />
      {error?.field === 'form' ? (
        <p role="alert" className="m-0 text-small text-danger">
          {error.text}
        </p>
      ) : null}
      {online ? null : (
        <p className="m-0 text-small text-ink-3">
          <Trans>Needs a connection</Trans>
        </p>
      )}
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={busy} isDisabled={!online}>
          <Trans>Add</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
