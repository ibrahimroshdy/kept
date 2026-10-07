/**
 * The create sheet (plan task 26; a bottom sheet on phones, a dialog on desktop): name, type (with
 * its icon), where (the move picker), quantity (hidden when the type forces one, D10), brand,
 * model, serial, a photo, and the optional purchase quick fields (date, shop, price + currency),
 * which appear only when Money is on and you may see money. Amounts accept Arabic digits and
 * `٫` (D172). While the name is empty, "From a template" fills the sheet from one (quick add,
 * plan T30), and the thing is created with its `templateId`.
 *
 * The thing's id is chosen here, so its photo uploads right after the create, attached to it.
 */
import { AmountError, can, effectiveModules, newId, parseAmount } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { FileTrigger } from 'react-aria-components';
import type { Template } from '@/api/capture/types';
import { useTypes } from '@/api/inventory/queries';
import { thingApi, useInvalidateThing } from '@/api/inventory/thing-api';
import type { CreateThingBody, MoveTarget, ThingView, TypeNode } from '@/api/inventory/types';
import { useLocation } from '@/api/queries';
import { CameraIcon, XIcon } from '@/components/icons';
import { useErrorText } from '@/components/page';
import { LogReadingForm, useCanLogReading } from '@/components/readings/log-reading-sheet';
import { FromTemplate, prefillOf } from '@/components/templates/quick-add';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { DialogFooter } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { sep } from '@/lib/format';
import { parseNumber } from './form-model';
import { markFresh } from './fresh';
import {
  CurrencyPicker,
  isChosen,
  RegistryPicker,
  TypePicker,
  useLocationAccountId,
  WherePicker,
  type WhereValue,
} from './pickers';
import { Sheet } from './sheet';
import { isHeic, uploadAndAttach, useUploadErrorText } from './upload';

const today = () => new Date().toISOString().slice(0, 10);

/** The type a preset key names: the account's copy of the built-in first, then the built-in. */
function presetTypeOf(
  types: readonly TypeNode[] | undefined,
  key: string | undefined,
): TypeNode | undefined {
  if (!key || !types) return undefined;
  const matches = types.filter((x) => x.builtinKey === key && !x.isFieldGroup && !x.archivedAt);
  return matches.find((x) => x.copiedFromId) ?? matches[0];
}

type Errors = Partial<Record<'name' | 'where' | 'quantity' | 'price' | 'currency', string>>;

export function CreateThingSheet({
  isOpen,
  onClose,
  locationId,
  target,
  openAfter = true,
  title,
  presetType,
}: {
  isOpen: boolean;
  onClose: () => void;
  locationId: string;
  /** Where it goes; empty ⇒ pick it in the sheet. */
  target?: MoveTarget;
  /** Open the new thing's page after it's made (default). */
  openAfter?: boolean;
  /** The sheet's title; "Add a thing" by default ("Add a thing to Garage" from Add here). */
  title?: string;
  /** A built-in type's key to start with (`car` from Add a vehicle); the account's own copy of
   * it wins. The type picker can still change or clear it. */
  presetType?: string;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const uploadErrorText = useUploadErrorText();
  const invalidate = useInvalidateThing();
  const [where, setWhere] = useState<WhereValue>({
    locationId,
    target: target ?? { placeId: '' },
  });
  const location = useLocation(where.locationId).data;
  const accountId = useLocationAccountId(location);
  const [name, setName] = useState('');
  /** The type picked in the sheet; null while nothing is picked (the preset shows). */
  const [picked, setPicked] = useState<{ type: TypeNode | undefined } | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [brandId, setBrandId] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [serial, setSerial] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [boughtOn, setBoughtOn] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  /** The step after creating a thing whose type has a default meter (D52, Q21): its first
   * reading, skippable. Holds what was made until it is logged or skipped. */
  const [first, setFirst] = useState<{
    id: string;
    name: string;
    locationId: string;
    meter: ThingView['meters'][number];
  } | null>(null);
  const canLog = useCanLogReading();
  /** The template picked, and the details it adds that the sheet has no field for. */
  const [template, setTemplate] = useState<{
    id: string;
    name: string;
    extra: Pick<CreateThingBody, 'colour' | 'notes' | 'tagIds' | 'aliases' | 'custom'>;
  } | null>(null);
  const types = useTypes(accountId);
  const type = picked ? picked.type : presetTypeOf(types.data?.types, presetType);
  const setType = (ty: TypeNode | undefined) => setPicked({ type: ty });
  const fromTemplate = (x: Template) => {
    const p = prefillOf(x);
    setName(p.name);
    const ty = p.typeId ? types.data?.types.find((ty) => ty.id === p.typeId) : undefined;
    if (ty) setType(ty);
    if (p.brandId) setBrandId(p.brandId);
    if (p.model) setModel(p.model);
    if (p.quantity !== undefined) setQuantity(String(p.quantity));
    setTemplate({
      id: x.id,
      name: x.name,
      extra: {
        ...(p.colour ? { colour: p.colour } : {}),
        ...(p.notes ? { notes: p.notes } : {}),
        ...(p.tagIds ? { tagIds: p.tagIds } : {}),
        ...(p.aliases ? { aliases: p.aliases } : {}),
        ...(p.custom ? { custom: p.custom } : {}),
      },
    });
  };

  const modules = location
    ? (location.effectiveModules ?? [
        ...effectiveModules(location.modules, { providerResolved: location.providerResolved }),
      ])
    : [];
  const showMoney = !!location && modules.includes('money') && can(location.role, 'money.view');
  const caps = type?.resolvedCapabilities ?? [];
  const quantityForced = caps.includes('serialized') || caps.includes('metered');

  const reset = () => {
    setName('');
    setPicked(null);
    setQuantity('1');
    setBrandId(null);
    setModel('');
    setSerial('');
    setPhoto(null);
    setBoughtOn(null);
    setVendorId(null);
    setPrice('');
    setCurrency(null);
    setErrors({});
    setTemplate(null);
  };

  const save = async () => {
    const e: Errors = {};
    if (!name.trim()) e.name = t`Give it a name.`;
    else if (name.trim().length > 200) e.name = t`At most 200 characters.`;
    if (!isChosen(where.target)) e.where = t`Choose where it is.`;
    const q = quantityForced ? 1 : parseNumber(quantity);
    if (q === null || Number.isNaN(q) || q < 0 || !Number.isInteger(q))
      e.quantity = t`Enter a whole number, 0 or more.`;
    let amount: string | null = null;
    if (showMoney && price.trim()) {
      try {
        amount = parseAmount(price);
      } catch (err) {
        if (!(err instanceof AmountError)) throw err;
        e.price = t`Enter an amount, like 1250 or 1250.50.`;
      }
      if (!currency) e.currency = t`A price needs a currency.`;
    }
    setErrors(e);
    if (Object.keys(e).length) return;

    const id = newId();
    const body: CreateThingBody = {
      id,
      locationId: where.locationId,
      ...where.target,
      name: name.trim(),
      ...(type ? { typeId: type.id } : {}),
      ...(quantityForced ? {} : { quantity: q ?? 1 }),
      ...(brandId ? { brandId } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(serial.trim() ? { serial: serial.trim() } : {}),
      ...(template ? { ...template.extra, templateId: template.id } : {}),
      ...(showMoney && amount && currency
        ? {
            purchase: {
              purchasedOn: boughtOn ?? today(),
              currency,
              price: amount,
              ...(vendorId ? { vendorId } : {}),
            },
          }
        : {}),
    };
    setBusy(true);
    try {
      const created = await thingApi.create(body);
      if (photo) {
        try {
          await uploadAndAttach({
            file: photo,
            locationId: where.locationId,
            subject: { thingId: created.id },
            role: 'photo',
          });
        } catch (err) {
          toast({
            title: t`Saved, but the photo didn't upload`,
            description: uploadErrorText(err),
            tone: 'danger',
          });
        }
      }
      await invalidate(created.id);
      markFresh(created.id);
      toast({ title: t`Added ${created.name ?? ''}`, tone: 'ok' });
      const meter = created.meters?.[0];
      if (meter && canLog(created.locationId)) {
        // Its type has a meter: ask for the first reading before leaving (skippable).
        setFirst({
          id: created.id,
          name: created.name ?? '',
          locationId: created.locationId,
          meter,
        });
        return;
      }
      reset();
      onClose();
      if (openAfter) await navigate({ to: '/t/$id', params: { id: created.id } });
    } catch (err) {
      toast({ title: t`Couldn't add it`, description: errorText(err), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const finishFirst = async () => {
    const id = first?.id;
    setFirst(null);
    reset();
    onClose();
    if (id && openAfter) await navigate({ to: '/t/$id', params: { id } });
  };

  if (first) {
    return (
      <Sheet
        isOpen={isOpen}
        onOpenChange={(o) => {
          if (!o) void finishFirst();
        }}
        title={t`Add the first reading`}
      >
        <div className="grid gap-3.5">
          <p className="m-0 text-small text-ink-2">
            <Trans>
              Kept tracks <bdi className="font-medium text-ink">{first.name}</bdi> from this reading
              on: its estimates and the services due by distance start here. You can add it later
              from its page.
            </Trans>
          </p>
          <LogReadingForm
            target={{
              thingId: first.id,
              thingName: first.name,
              locationId: first.locationId,
              meter: first.meter,
            }}
            cancelLabel={t`Skip`}
            onClose={() => void finishFirst()}
          />
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={title ?? t`Add a thing`}
    >
      <form
        noValidate
        aria-label={t`Add a thing`}
        className="grid gap-3.5"
        onSubmit={(ev) => {
          ev.preventDefault();
          void save();
        }}
      >
        <TextField
          label={t`Name`}
          value={name}
          onChange={setName}
          autoFocus
          inputProps={{ dir: 'auto' }}
          {...(errors.name ? { errorMessage: errors.name, isInvalid: true } : {})}
        />
        {!name.trim() ? (
          <FromTemplate locationId={where.locationId} onPick={fromTemplate} />
        ) : template ? (
          <p className="m-0 text-small text-ink-2">
            <Trans>
              From the template <bdi className="font-medium text-ink">{template.name}</bdi>
            </Trans>
          </p>
        ) : null}
        <TypePicker
          accountId={accountId}
          label={t`Type`}
          value={type?.id ?? null}
          onChange={(_id, ty) => setType(ty)}
        />
        {target ? null : (
          <div className="grid gap-1">
            <WherePicker value={where} onChange={setWhere} label={t`Where it is`} />
            {errors.where ? (
              <span role="alert" className="text-small font-medium text-danger">
                {errors.where}
              </span>
            ) : null}
          </div>
        )}
        {quantityForced ? null : (
          <TextField
            label={t`Quantity`}
            value={quantity}
            onChange={setQuantity}
            inputProps={{ inputMode: 'numeric', dir: 'ltr' }}
            {...(errors.quantity ? { errorMessage: errors.quantity, isInvalid: true } : {})}
          />
        )}
        <RegistryPicker
          kind="brands"
          accountId={accountId}
          label={t`Brand`}
          value={brandId}
          onChange={setBrandId}
        />
        <div className="grid gap-3.5 md:grid-cols-2">
          <TextField
            label={t`Model`}
            value={model}
            onChange={setModel}
            inputProps={{ dir: 'auto' }}
          />
          <TextField
            label={t`Serial number`}
            value={serial}
            onChange={setSerial}
            inputProps={{ dir: 'ltr' }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FileTrigger acceptedFileTypes={['image/*']} onSelect={(f) => setPhoto(f?.[0] ?? null)}>
            <Button variant="secondary" size="small">
              <CameraIcon className="size-4" />
              {photo ? <Trans>Change photo</Trans> : <Trans>Add a photo</Trans>}
            </Button>
          </FileTrigger>
          {photo ? (
            <span className="inline-flex items-center gap-1 text-small text-ink-2">
              <bdi>{photo.name}</bdi>
              {isHeic(photo.type) ? (
                <span className="text-ink-3">
                  {sep()}
                  <Trans>preview unavailable</Trans>
                </span>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                aria-label={t`Remove the photo`}
                onPress={() => setPhoto(null)}
              >
                <XIcon />
              </Button>
            </span>
          ) : null}
        </div>
        {showMoney ? (
          <fieldset className="m-0 grid gap-3 rounded-[10px] border border-line p-3">
            <legend className="px-1 text-small font-semibold text-ink-3">
              <Trans>Purchase (optional)</Trans>
            </legend>
            <DatePicker
              label={t`Bought on`}
              value={boughtOn}
              onChange={setBoughtOn}
              maxValue={today()}
            />
            <RegistryPicker
              kind="vendors"
              accountId={accountId}
              label={t`Shop`}
              value={vendorId}
              onChange={setVendorId}
            />
            <div className="grid gap-3 md:grid-cols-[1fr_10rem]">
              <TextField
                label={t`Price`}
                value={price}
                onChange={setPrice}
                inputProps={{ inputMode: 'decimal', dir: 'ltr' }}
                {...(errors.price ? { errorMessage: errors.price, isInvalid: true } : {})}
              />
              <div className="grid gap-1">
                <CurrencyPicker label={t`Currency`} value={currency} onChange={setCurrency} />
                {errors.currency ? (
                  <span role="alert" className="text-small font-medium text-danger">
                    {errors.currency}
                  </span>
                ) : null}
              </div>
            </div>
          </fieldset>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onPress={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" isPending={busy}>
            <Trans>Add</Trans>
          </Button>
        </DialogFooter>
      </form>
    </Sheet>
  );
}
