/**
 * What every part of the thing screen needs to know: the thing, its location, the caller's role
 * there and which modules are on. Controls follow screens §3: hidden when the role can't use
 * them, "Off in this location" when a module is off (with "Turn on" for admins).
 */
import {
  type Action,
  can as canDo,
  effectiveModules,
  type ModuleId,
  type Role,
} from '@kept/shared';
import { Trans } from '@lingui/react/macro';
import { createContext, type ReactNode, useContext } from 'react';
import type { ThingView } from '@/api/inventory/types';
import type { LocationDetail } from '@/api/types';
import { LinkButton, Notice } from '@/components/page';
import { sep } from '@/lib/format';

export type ThingCtx = {
  thing: ThingView;
  location: LocationDetail;
  role: Role;
  /** `can(role, action)` in the thing's location. */
  can: (action: Action) => boolean;
  moduleOn: (id: ModuleId) => boolean;
  /** The caller's display name (readings "logged by me"). */
  me: string;
  /** Refetch the thing and everything that lists it. */
  refresh: () => Promise<void>;
};

const Ctx = createContext<ThingCtx | null>(null);

export function ThingProvider({ value, children }: { value: ThingCtx; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useThingCtx(): ThingCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useThingCtx() needs a <ThingProvider>');
  return v;
}

export function makeCtx(
  thing: ThingView,
  location: LocationDetail,
  me: string,
  refresh: () => Promise<void>,
): ThingCtx {
  const on = new Set<ModuleId>(
    location.effectiveModules ??
      effectiveModules(location.modules, { providerResolved: location.providerResolved }),
  );
  return {
    thing,
    location,
    role: location.role,
    can: (action) => canDo(location.role, action),
    moduleOn: (id) => on.has(id),
    me,
    refresh,
  };
}

/** Screens §3: a module that is off, said plainly, with the way to turn it on. */
export function ModuleOff({ what, className }: { what: ReactNode; className?: string }) {
  const { location, role } = useThingCtx();
  const admin = role === 'owner' || role === 'admin';
  return (
    <Notice
      className={className}
      title={
        <>
          {what}
          {sep()}
          <Trans>Off in this location</Trans>
        </>
      }
      action={
        admin ? (
          <LinkButton size="small" to="/settings/location/$id/track" params={{ id: location.id }}>
            <Trans>Turn on</Trans>
          </LinkButton>
        ) : undefined
      }
    >
      {admin ? null : <Trans>Ask an admin of this location to turn it on.</Trans>}
    </Notice>
  );
}
