/**
 * The first capture into a new home (D194): a one-tap grid of its rooms, so the first things
 * don't quietly land in Unplaced where nobody finds them. Unplaced is still one of the choices,
 * said out loud; "Another place" opens the full place sheet.
 */

import type { SnapPlace } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from 'react-aria-components';

const tile =
  'flex min-h-14 cursor-pointer items-center justify-center rounded-xl border border-[#34302A] bg-[#26231F] px-3 py-2 text-center font-semibold text-[#F2EFE9] text-[14.5px] leading-tight outline-none [overflow-wrap:anywhere] data-focus-visible:outline-2 data-focus-visible:outline-[#F2EFE9] data-pressed:bg-[#34302A]';

export function RoomGrid({
  home,
  rooms,
  onRoom,
  onUnplaced,
  onOther,
}: {
  home: string;
  rooms: readonly SnapPlace[];
  onRoom: (placeId: string) => void;
  onUnplaced: () => void;
  onOther: () => void;
}) {
  const { t } = useLingui();
  return (
    <section
      aria-labelledby="room-grid-title"
      className="absolute inset-0 z-10 grid content-start gap-3 overflow-y-auto bg-[#0F0E0D]/95 p-4"
    >
      <div className="grid gap-1">
        <h2 id="room-grid-title" className="m-0 font-semibold text-[#F2EFE9] text-[18px]">
          <Trans>Which room are you in?</Trans>
        </h2>
        <p className="m-0 text-[#BDB7AC] text-[13.5px]">
          <Trans>
            The first things in <bdi>{home}</bdi> go where you choose. You can change it any time
            from the place at the top.
          </Trans>
        </p>
      </div>
      <fieldset className="m-0 grid grid-cols-2 gap-2 border-0 p-0">
        <legend className="sr-only">{t`Rooms`}</legend>
        {rooms.map((r) => (
          <Button key={r.id} className={tile} onPress={() => onRoom(r.id)}>
            <bdi>{r.name}</bdi>
          </Button>
        ))}
        <Button className={tile} onPress={onOther}>
          <Trans>Another place</Trans>
        </Button>
        <Button className={`${tile} font-medium text-[#BDB7AC]`} onPress={onUnplaced}>
          <Trans>Unplaced for now</Trans>
        </Button>
      </fieldset>
    </section>
  );
}
