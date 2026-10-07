/**
 * New location (screens §6, D194): three steps, skippable after the name. Name and kind → rooms
 * ("Add room or spot", with the template's rooms filled in) → what to track (the preset cards).
 * The last step shows the timezone and currency taken from this browser; both are editable in
 * Location settings. Inviting people is a Home card afterwards, not a step.
 */
import type { Preset } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { Input, Radio, RadioGroup, TextField as TextFieldPrimitive } from 'react-aria-components';
import { createLocation } from '@/api/locations';
import { keys } from '@/api/queries';
import type { LocationKind } from '@/api/types';
import { StepCounter } from '@/components/auth-frame';
import { InfoIcon, LockIcon, PlusIcon, XIcon } from '@/components/icons';
import { KindIcon } from '@/components/kind-icon';
import { Notice, Page, useErrorText } from '@/components/page';
import { PresetPicker } from '@/components/preset-picker';
import { Button } from '@/components/ui/button';
import { inputClass, Label } from '@/components/ui/field';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import {
  browserCurrency,
  browserTimezone,
  CREATABLE_KINDS,
  useKindLabels,
  useTemplateRooms,
} from '@/lib/labels';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/locations/new')({ component: NewLocation });

type Kind = Exclude<LocationKind, 'personal'>;
type Room = { key: number; name: string };

let roomKey = 0;
const toRooms = (names: string[]): Room[] => names.map((name) => ({ key: ++roomKey, name }));

function NewLocation() {
  const { t } = useLingui();
  const kinds = useKindLabels();
  const templates = useTemplateRooms();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const [kind, setKind] = useState<Kind>('apartment');
  const [rooms, setRooms] = useState<Room[]>(() => toRooms(templates.apartment));
  const [roomsFor, setRoomsFor] = useState<Kind>('apartment');
  const [preset, setPreset] = useState<Preset>('household');
  const timezone = browserTimezone();
  const currency = browserCurrency();
  const displayName = name.trim() || kinds[kind];

  const create = useMutation({
    mutationFn: () =>
      createLocation({
        name: name.trim(),
        kind,
        rooms: rooms.map((r) => r.name.trim()).filter(Boolean),
        preset,
        timezone,
        currency,
      }),
    onSuccess: async (created) => {
      await qc.invalidateQueries({ queryKey: keys.locations });
      const createdName = created.name;
      toast({ title: t`${createdName} is ready`, tone: 'ok' });
      void navigate({ to: '/' });
    },
    onError: (e) => toast({ title: errorText(e), tone: 'danger' }),
  });

  const nextFromName = () => {
    const n = name.trim();
    if (n.length < 1) return setNameError(t`Give it a name, like Home or Garage.`);
    if (n.length > 120) return setNameError(t`Keep the name under 120 characters.`);
    setNameError(undefined);
    // A different kind than the rooms were made for brings its own template.
    if (roomsFor !== kind) {
      setRooms(toRooms(templates[kind]));
      setRoomsFor(kind);
    }
    setStep(2);
  };

  const steps = 3;
  const footer = (
    <div className="sticky bottom-[calc(56px+env(safe-area-inset-bottom))] z-10 -mx-3.5 flex items-center gap-2 border-t border-line bg-surface px-3.5 pt-3 pb-9 md:static md:py-3 md:mx-0 md:rounded-[10px] md:border">
      {step > 1 ? (
        <Button variant="secondary" onPress={() => setStep(step - 1)}>
          <Trans>Back</Trans>
        </Button>
      ) : null}
      <span className="flex-1" />
      {step === 2 ? (
        <Button
          variant="ghost"
          onPress={() => {
            setRooms([]);
            setStep(3);
          }}
        >
          <Trans>Skip</Trans>
        </Button>
      ) : null}
      {step === 1 ? (
        <Button onPress={nextFromName}>
          <Trans>Next</Trans>
        </Button>
      ) : step === 2 ? (
        <Button onPress={() => setStep(3)}>
          <Trans>Next</Trans>
        </Button>
      ) : (
        <Button isPending={create.isPending} onPress={() => create.mutate()}>
          <Trans>Create {displayName}</Trans>
        </Button>
      )}
    </div>
  );

  return (
    <Page
      title={t`New location`}
      back="/"
      actions={
        <span className="eyebrow whitespace-nowrap">
          <StepCounter current={step} total={steps} />
        </span>
      }
    >
      <div aria-hidden="true" className="flex gap-1.5">
        {[1, 2, 3].map((s) => (
          <span
            key={s}
            className={cn('h-1 flex-1 rounded-full', s <= step ? 'bg-ink' : 'bg-line')}
          />
        ))}
      </div>

      {step === 1 ? (
        <div className="grid gap-5">
          <h2 className="m-0 font-semibold text-[22px] leading-tight">
            <Trans>What's this place called?</Trans>
          </h2>
          <TextField
            label={t`Name`}
            value={name}
            onChange={(v) => {
              setName(v);
              if (nameError) setNameError(undefined);
            }}
            isInvalid={!!nameError}
            errorMessage={nameError}
            placeholder={t`e.g. Home`}
            autoFocus
            maxLength={120}
          />
          <KindPicker value={kind} onChange={setKind} />
        </div>
      ) : null}

      {step === 2 ? (
        <RoomsStep
          name={displayName}
          kindLabel={kinds[kind]}
          hasTemplate={templates[kind].length > 0}
          rooms={rooms}
          setRooms={setRooms}
        />
      ) : null}

      {step === 3 ? (
        <div className="grid gap-4">
          <h2 className="m-0 font-semibold text-[22px] leading-tight">
            <Trans>What should {displayName} track?</Trans>
          </h2>
          <PresetPicker value={preset} onChange={setPreset} />
          <Notice tone="info">
            <div className="grid gap-1.5">
              <span>
                <Trans>
                  AI capture and the assistant come on in any preset once an AI provider is
                  connected.
                </Trans>
              </span>
              <span>
                <Trans>
                  <strong className="ltr text-ink">
                    {timezone} · {currency}
                  </strong>{' '}
                  from this device. Change these and single modules in Location settings.
                </Trans>
              </span>
            </div>
          </Notice>
        </div>
      ) : null}

      {footer}
    </Page>
  );
}

function KindPicker({ value, onChange }: { value: Kind; onChange: (k: Kind) => void }) {
  const { t } = useLingui();
  const kinds = useKindLabels();
  return (
    <RadioGroup
      value={value}
      onChange={(v) => onChange(v as Kind)}
      className="grid gap-1.5"
      aria-label={t`Kind`}
    >
      <Label>
        <Trans>Kind</Trans>
      </Label>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {CREATABLE_KINDS.map((k) => (
          <Radio
            key={k}
            value={k}
            className="flex min-h-12 cursor-pointer items-center gap-2 rounded-[10px] border border-line bg-surface px-3 py-2 text-[14px] leading-tight text-ink outline-none data-selected:border-2 data-selected:border-ink data-selected:px-[11px] data-selected:font-semibold data-focus-visible:outline-2 data-focus-visible:outline-offset-2 data-focus-visible:outline-info [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-ink-2"
          >
            <KindIcon kind={k} />
            {kinds[k]}
          </Radio>
        ))}
      </div>
    </RadioGroup>
  );
}

function RoomsStep({
  name,
  kindLabel,
  hasTemplate,
  rooms,
  setRooms,
}: {
  name: string;
  kindLabel: string;
  hasTemplate: boolean;
  rooms: Room[];
  setRooms: (r: Room[]) => void;
}) {
  const { t } = useLingui();
  const listId = useId();
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="m-0 font-semibold text-[22px] leading-tight">
          <Trans>Rooms in {name}</Trans>
        </h2>
        <p className="m-0 text-ink-2">
          {hasTemplate ? (
            <Trans>
              From the {kindLabel} template. Rename, remove or add; change them any time.
            </Trans>
          ) : (
            <Trans>Add the rooms and spots you'll put things in. Change them any time.</Trans>
          )}
        </p>
      </div>
      <ul
        id={listId}
        className="m-0 grid list-none overflow-hidden rounded-[10px] border border-line bg-surface p-0 [&>li+li]:border-t [&>li+li]:border-line"
      >
        {rooms.map((room, i) => {
          const n = i + 1;
          const roomName = room.name;
          return (
            <li key={room.key} className="flex items-center gap-2 px-2.5 py-2">
              <TextFieldPrimitive
                aria-label={t`Room or spot ${n}`}
                value={room.name}
                onChange={(v) =>
                  setRooms(rooms.map((r) => (r.key === room.key ? { ...r, name: v } : r)))
                }
                maxLength={120}
                className="flex-1"
              >
                <Input
                  // A room just added gets the cursor.
                  autoFocus={room.name === '' && i === rooms.length - 1}
                  className={cn(inputClass, 'border-transparent bg-transparent')}
                />
              </TextFieldPrimitive>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t`Remove ${roomName}`}
                onPress={() => setRooms(rooms.filter((r) => r.key !== room.key))}
              >
                <XIcon />
              </Button>
            </li>
          );
        })}
        <li className="flex items-center gap-3 bg-sunken/60 px-3.5 py-3">
          <LockIcon className="size-4 shrink-0 text-ink-3" />
          <div className="grid gap-0.5">
            <div className="font-semibold text-[15px]">
              <Trans>Unplaced</Trans>
            </div>
            <div className="text-small text-ink-2">
              <Trans>Always there, for things that don't have a place yet</Trans>
            </div>
          </div>
        </li>
      </ul>
      <Button
        variant="secondary"
        className="w-full"
        onPress={() => setRooms([...rooms, ...toRooms([''])])}
      >
        <PlusIcon />
        <Trans>Add room or spot</Trans>
      </Button>
      <p className="m-0 flex items-start gap-2 text-small text-ink-3">
        <InfoIcon className="mt-px size-4 shrink-0" />
        <Trans>Skip keeps only Unplaced. You can add rooms later from the location.</Trans>
      </p>
    </div>
  );
}
