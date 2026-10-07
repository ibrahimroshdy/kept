import type { LocationKind } from '@/api/types';
import {
  BoxIcon,
  BriefcaseIcon,
  BuildingIcon,
  GarageIcon,
  HouseIcon,
  PalmIcon,
  PersonIcon,
} from '@/components/icons';

/** One icon per location kind (screens §5 Home: "kind icon"). Decorative. */
export function KindIcon({ kind, className }: { kind: LocationKind; className?: string }) {
  const p = className ? { className } : {};
  switch (kind) {
    case 'personal':
      return <PersonIcon {...p} />;
    case 'apartment':
      return <BuildingIcon {...p} />;
    case 'home':
      return <HouseIcon {...p} />;
    case 'garage':
      return <GarageIcon {...p} />;
    case 'office':
      return <BriefcaseIcon {...p} />;
    case 'vacation_home':
      return <PalmIcon {...p} />;
    default:
      return <BoxIcon {...p} />;
  }
}
