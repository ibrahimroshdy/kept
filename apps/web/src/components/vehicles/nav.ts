/**
 * Moving between a vehicle's tabs from inside one (an Overview card's "All", a banner's Open):
 * from `md` up it opens the tab (`?tab=`); on a phone, where every tab is a section of one page,
 * it scrolls to the section. thing-screen.tsx provides it.
 */
import { createContext, useContext } from 'react';

export type VehicleNavTab =
  | 'overview'
  | 'readings'
  | 'services'
  | 'fuel'
  | 'schedules'
  | 'documents'
  | 'costs'
  | 'details';

type VehicleNav = { go: (tab: VehicleNavTab) => void };
const Nav = createContext<VehicleNav>({ go: () => {} });
export const VehicleNavProvider = Nav.Provider;
export const useVehicleNav = () => useContext(Nav);
