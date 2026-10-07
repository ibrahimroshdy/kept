/**
 * A brand's logo (step-4 T9; step-2 Q9, plan Q33). `GET /api/v1/brands/:id/logo` is a PNG Kept
 * made of the upload. `GET /api/v1/brands/:id` says whether there is one (`hasLogo`), so the
 * page asks for no image it would get a 404 for (UI step-4 review L8); without the flag (the
 * mock) a 404 still means no logo, and the brand's icon stays. Its account's owners and admins add, replace and remove it (`PUT` with the image as the
 * body, `DELETE`, same path): PNG, JPEG, WebP or SVG up to 2 MB, of which the server keeps only a
 * PNG. After a change the image's address carries the new version, so the browser's copy (a day,
 * revalidated) never shows the old one.
 *
 * Loaded on demand (vite.config.ts, assets/household/): it reads the server, so it's no use
 * offline before its first load; until it loads, the brand's icon shows.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { FileTrigger } from 'react-aria-components';
import { householdPaths } from '@/api/household/paths';
import { householdApi } from '@/api/household/queries';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { useOnline } from '@/lib/online';

const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

/** What the page knows of the logo: its version for the address, and whether it loaded. */
type LogoState = { version: string; present: boolean | null };
const keyOf = (brandId: string) => ['brand-logo', brandId] as const;

function useLogoState(brandId: string) {
  const qc = useQueryClient();
  const q = useQuery<LogoState>({
    queryKey: keyOf(brandId),
    queryFn: () => ({ version: '', present: null }),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const state = q.data ?? { version: '', present: null };
  const set = (next: Partial<LogoState>) =>
    qc.setQueryData<LogoState>(keyOf(brandId), (old) => ({
      ...(old ?? { version: '', present: null }),
      ...next,
    }));
  return [state, set] as const;
}

/** The logo in the brand's tile, or `fallback` (its icon) while there's none. */
export function BrandLogo({
  brandId,
  name,
  hasLogo,
  fallback,
}: {
  brandId: string;
  name: string;
  /** The brand's `hasLogo`, when the server sent it. */
  hasLogo?: boolean | undefined;
  fallback: ReactNode;
}) {
  const { t } = useLingui();
  const [state, set] = useLogoState(brandId);
  // Known to have none, and none added since this page loaded: nothing to ask for.
  const none = state.version === 'none' || (hasLogo === false && !state.version);
  const src = `${householdPaths.brandLogo(brandId)}${state.version ? `?v=${state.version}` : ''}`;
  return (
    <>
      {state.present === false || none ? null : (
        <img
          key={src}
          src={src}
          alt={t`Logo of ${name}`}
          className={
            state.present
              ? 'size-12 shrink-0 rounded-[10px] border border-line bg-white object-contain p-1'
              : 'hidden'
          }
          onLoad={() => set({ present: true })}
          onError={() => set({ present: false })}
        />
      )}
      {state.present ? null : fallback}
    </>
  );
}

/** Add, replace or remove the logo: the brand's account owners and admins. */
export function BrandLogoActions({ brandId }: { brandId: string }) {
  const { t } = useLingui();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const online = useOnline();
  const [state, set] = useLogoState(brandId);
  const [busy, setBusy] = useState<'put' | 'delete' | null>(null);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy('put');
    try {
      const logo = await householdApi.putBrandLogo(brandId, file);
      set({ version: logo.sha256, present: null });
    } catch (e) {
      toast({ tone: 'danger', title: t`Couldn't save it`, description: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: t`Remove the logo?`,
      body: t`The brand's icon shows instead.`,
      confirmLabel: t`Remove`,
      destructive: true,
    });
    if (!ok) return;
    setBusy('delete');
    try {
      await householdApi.deleteBrandLogo(brandId);
      set({ version: 'none', present: false });
    } catch (e) {
      toast({ tone: 'danger', title: t`Couldn't remove it`, description: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <FileTrigger acceptedFileTypes={ACCEPT} onSelect={(list) => void upload(list?.[0])}>
          <Button
            variant="secondary"
            size="small"
            isDisabled={!online || busy !== null}
            isPending={busy === 'put'}
          >
            {state.present ? <Trans>Replace the logo</Trans> : <Trans>Add a logo</Trans>}
          </Button>
        </FileTrigger>
        {state.present ? (
          <Button
            variant="ghost"
            size="small"
            className="text-danger"
            isDisabled={!online || busy !== null}
            isPending={busy === 'delete'}
            onPress={() => void remove()}
          >
            <Trans>Remove the logo</Trans>
          </Button>
        ) : null}
      </div>
      <p className="m-0 text-small text-ink-3">
        {online ? (
          <Trans>PNG, JPEG, WebP or SVG, up to 2 MB.</Trans>
        ) : (
          <Trans>Needs a connection</Trans>
        )}
      </p>
    </div>
  );
}
