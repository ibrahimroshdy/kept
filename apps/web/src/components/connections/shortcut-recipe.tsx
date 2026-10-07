/**
 * Help → "Log your odometer from an iPhone Shortcut" (D63, master plan 9.5, step-6 plan T21): a
 * Shortcut that asks for the odometer and sends it to Kept's public API with a token. Written
 * from the real route, `POST /api/v1/meters/:id/readings` with `{value, takenAt}` (apps/server
 * meters/routes.ts: `value` a decimal string, `takenAt` an ISO date-time with its offset), and
 * the bearer header personal tokens use (T10). Picking a car fills in its meter's address, so
 * nobody has to find a meter's id.
 *
 * The Shortcuts actions are named as Apple's Shortcuts app names them; that the recipe runs on a
 * real iPhone is on step 6's device checklist (maintainer check pending). The token stays on the
 * phone, inside the Shortcut: the recipe says so.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { type ReactNode, useState } from 'react';
import { useVehicles } from '@/api/vehicles/queries';
import { LinkButton, Notice } from '@/components/page';
import { Sheet } from '@/components/places/sheet';
import { CopyButton } from '@/components/ui/copy-button';
import { Select, SelectItem } from '@/components/ui/select';

const origin = () => (typeof location === 'undefined' ? '' : location.origin);

export function ShortcutRecipeSheet({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t`Log your odometer from an iPhone Shortcut`}
      wide
    >
      <Recipe />
    </Sheet>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
      <span
        aria-hidden="true"
        className="grid size-7 place-items-center rounded-full bg-sunken font-semibold text-[13px] text-ink"
      >
        {n}
      </span>
      <div className="grid gap-1.5 text-[15px] text-ink">{children}</div>
    </li>
  );
}

function Value({ text, copy }: { text: string; copy?: string }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <code
        dir="ltr"
        className="min-w-0 flex-1 basis-56 select-all break-all rounded-md bg-sunken px-2 py-1 font-mono text-[13px]"
      >
        {text}
      </code>
      {copy ? <CopyButton text={text} label={copy} size="small" /> : null}
    </span>
  );
}

function Recipe() {
  const { t } = useLingui();
  const cars = useVehicles();
  const withMeter = (cars.data?.pages.flatMap((p) => p.items) ?? []).filter((v) => v.meter);
  const [carId, setCarId] = useState<string | null>(null);
  const car = withMeter.find((v) => v.thing.id === carId) ?? withMeter[0];
  const meterId = car?.meter?.id;
  const url = `${origin()}/api/v1/meters/${meterId ?? '<meter id>'}/readings`;
  return (
    <div className="grid gap-4">
      <p className="m-0 text-ink-2">
        <Trans>
          Tap the Shortcut at the pump or in the car park, type the odometer, and the reading is in
          Kept, with undo, as if you'd logged it here.
        </Trans>
      </p>
      {withMeter.length > 1 ? (
        <Select
          label={t`Car`}
          items={withMeter.map((v) => ({ id: v.thing.id, name: v.thing.name ?? '' }))}
          value={car?.thing.id ?? null}
          onChange={(key) => setCarId(String(key))}
        >
          {(o) => (
            <SelectItem id={o.id} textValue={o.name}>
              <bdi>{o.name}</bdi>
            </SelectItem>
          )}
        </Select>
      ) : null}
      {!meterId && !cars.isPending ? (
        <Notice tone="info">
          <Trans>
            Add your car to Kept with an odometer reading first; its address appears here then.
          </Trans>
        </Notice>
      ) : null}
      <ol className="m-0 grid list-none gap-4 p-0">
        <Step n={1}>
          <span>
            <Trans>
              In Settings → Connections, make a token that can read and change, for the car's
              location only. Copy it.
            </Trans>
          </span>
          <LinkButton to="/settings/connections" size="small" className="justify-self-start">
            <Trans>Open Connections</Trans>
          </LinkButton>
        </Step>
        <Step n={2}>
          <Trans>
            In the Shortcuts app, make a new Shortcut. Add <strong>Ask for Input</strong>, set to
            Number, with the prompt "Odometer".
          </Trans>
        </Step>
        <Step n={3}>
          <Trans>
            Add <strong>Get Contents of URL</strong> with this address, and set its method to POST:
          </Trans>
          <Value text={url} copy={t`Copy address`} />
        </Step>
        <Step n={4}>
          <Trans>Under Headers, add these two:</Trans>
          <Value text="Authorization: Bearer <your token>" />
          <Value text="Content-Type: application/json" />
          <span className="text-small text-ink-2">
            <Trans>Paste your token in place of the angle brackets and what's between them.</Trans>
          </span>
        </Step>
        <Step n={5}>
          <Trans>
            Set Request Body to JSON with two text fields: <code dir="ltr">value</code>, the number
            you typed, and <code dir="ltr">takenAt</code>, the Current Date formatted as ISO 8601
            with the time.
          </Trans>
          <Value text={'{"value": "53000", "takenAt": "2026-10-06T08:30:00+03:00"}'} />
        </Step>
      </ol>
      <Notice tone="warn" title={<Trans>The token lives in the Shortcut</Trans>}>
        <Trans>
          Anyone who can open the Shortcut on your phone can log readings in that location. If the
          phone is lost, revoke the token in Settings → Connections.
        </Trans>
      </Notice>
    </div>
  );
}
