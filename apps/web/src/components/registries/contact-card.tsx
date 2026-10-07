/**
 * A person's contact card (D177, Q5): phone, email and notes. The server answers 404 unless you
 * are an admin of every location that uses the person (or of any, when none does), so the card
 * shows only when the server returns it; it is never "hidden" with a placeholder. Contact fields
 * are audited as secret, so history says "changed" and never the value. Not offline (§4).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import type { PersonContact } from '@/api/inventory/types';
import { MailIcon, PhoneIcon } from '@/components/icons';
import { Notice, Section, useErrorText } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { registryApi, registryKeys, useContact } from './api';

export function ContactCard({
  personId,
  name,
  canEdit,
}: {
  personId: string;
  name: string;
  canEdit: boolean;
}) {
  const { t } = useLingui();
  // Only an admin can be shown the card: someone who manages no location of the account isn't
  // asked for it, so a viewer's page logs no 404 (UI step-4 review L8).
  const contact = useContact(personId, canEdit);
  const [editing, setEditing] = useState(false);
  if (!contact.data) return null;
  const c = contact.data;
  const empty = !c.phone && !c.email && !c.notes;
  return (
    <Section
      title={<Trans>Contact</Trans>}
      action={
        canEdit ? (
          <Button size="small" variant="ghost" onPress={() => setEditing(true)}>
            <Trans>Edit</Trans>
          </Button>
        ) : undefined
      }
    >
      <div className="grid gap-2 rounded-[10px] border border-line bg-surface p-3.5">
        {empty ? (
          <p className="m-0 text-small text-ink-2">
            <Trans>No contact details yet.</Trans>
          </p>
        ) : null}
        {c.phone ? (
          <a
            href={`tel:${c.phone.replace(/[^\d+]/g, '')}`}
            className="inline-flex min-h-11 items-center gap-2 justify-self-start text-ink outline-none hover:underline focus-visible:outline-2 focus-visible:outline-info"
          >
            <PhoneIcon className="size-[18px] text-ink-2" aria-hidden="true" />
            <span dir="ltr">{c.phone}</span>
          </a>
        ) : null}
        {c.email ? (
          <a
            href={`mailto:${c.email}`}
            className="inline-flex min-h-11 items-center gap-2 justify-self-start text-ink outline-none hover:underline focus-visible:outline-2 focus-visible:outline-info [overflow-wrap:anywhere]"
          >
            <MailIcon className="size-[18px] text-ink-2" aria-hidden="true" />
            <span dir="ltr">{c.email}</span>
          </a>
        ) : null}
        {c.notes ? (
          <p className="m-0 whitespace-pre-wrap text-ink-2" dir="auto">
            {c.notes}
          </p>
        ) : null}
        <p className="m-0 text-small text-ink-3">
          <Trans>
            Only admins of every location that uses <bdi>{name}</bdi> see these, and never offline.
          </Trans>
        </p>
      </div>
      <Sheet isOpen={editing} onOpenChange={setEditing} title={t`Contact for ${name}`}>
        {({ close }) => <ContactForm personId={personId} contact={c} onDone={close} />}
      </Sheet>
    </Section>
  );
}

function ContactForm({
  personId,
  contact,
  onDone,
}: {
  personId: string;
  contact: PersonContact;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const [phone, setPhone] = useState(contact.phone ?? '');
  const [email, setEmail] = useState(contact.email ?? '');
  const [notes, setNotes] = useState(contact.notes ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () =>
      registryApi.putContact(personId, {
        phone: phone.trim() || null,
        email: email.trim() || null,
        notes: notes.trim() || null,
      }),
    onSuccess: (next) => {
      qc.setQueryData(registryKeys.contact(personId), next);
      toast({ title: t`Contact saved`, tone: 'ok' });
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (phone.trim().length > 40) next.phone = t`Keep the phone number to 40 characters.`;
    if (email.trim() && !/^[^\s@]+@[^\s@]+$/.test(email.trim()))
      next.email = t`That doesn't look like an email address.`;
    if (notes.length > 5000) next.notes = t`Keep notes to 5,000 characters.`;
    setErrors(next);
    if (Object.keys(next).length === 0) save.mutate();
  };
  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <TextField
        label={t`Phone`}
        value={phone}
        onChange={setPhone}
        type="tel"
        inputProps={{ dir: 'ltr' }}
        {...(errors.phone ? { errorMessage: errors.phone, isInvalid: true } : {})}
      />
      <TextField
        label={t`Email`}
        value={email}
        onChange={setEmail}
        type="email"
        inputProps={{ dir: 'ltr' }}
        {...(errors.email ? { errorMessage: errors.email, isInvalid: true } : {})}
      />
      <TextField
        label={t`Notes`}
        value={notes}
        onChange={setNotes}
        inputProps={{ dir: 'auto' }}
        {...(errors.notes ? { errorMessage: errors.notes, isInvalid: true } : {})}
      />
      {save.error ? <Notice tone="danger">{errorText(save.error)}</Notice> : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onDone}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" isPending={save.isPending}>
          <Trans>Save</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
