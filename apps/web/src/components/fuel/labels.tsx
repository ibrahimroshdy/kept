/**
 * Fuel and charging in words (plan T21; D28, D170; Q6, Q7, Q22): a unit's name, an amount with its
 * unit, a consumption in the reader's units (metric L/100 km and kWh/100 km, imperial mpg and
 * mi/kWh, per hour on an hours meter: @kept/shared `displayConsumption`), and why there is no
 * consumption yet (`whyNone`). Only the derived figure follows the reader's units; a fill's own
 * litres, kWh or gallons are shown as stored (D76).
 */
import {
  type ConsumptionWhyNone,
  displayConsumption,
  type FuelUnit,
  type UnitSystem,
} from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { type SVGProps, useMemo } from 'react';
import { useMe } from '@/api/queries';
import { formatLocale, usePrefs } from '@/lib/prefs';

/** A fuel pump, in the icon set's style (24-unit box, 1.8 stroke; the board's `a5-fuel`). */
export function FuelIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M4 20V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15M3 20h12M4 10h10M14 9h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V8l-3-3" />
    </svg>
  );
}

/** The short unit after an amount ("40 L", "38 kWh", "10.5 gal"). */
export function useFuelUnitShort(): Record<FuelUnit, string> {
  const { t } = useLingui();
  return { L: t`L`, kWh: t`kWh`, gal: t`gal` };
}

/** The unit's name, for the choice in Log fuel. */
export function useFuelUnitNames(): Record<FuelUnit, string> {
  const { t } = useLingui();
  return { L: t`Litres`, kWh: t`kWh`, gal: t`US gallons` };
}

/** A decimal in the reader's digits with exactly `dp` decimals ("7.3", "٧٫٣", "40.0"). */
export function useDecimal() {
  const { locale, digits } = usePrefs();
  return useMemo(() => {
    const cache = new Map<number, Intl.NumberFormat>();
    return (value: string | number, dp: number) => {
      let nf = cache.get(dp);
      if (!nf) {
        nf = new Intl.NumberFormat(formatLocale(locale, digits), {
          minimumFractionDigits: dp,
          maximumFractionDigits: dp,
        });
        cache.set(dp, nf);
      }
      const n = Number(value);
      return Number.isFinite(n) ? nf.format(n) : String(value);
    };
  }, [locale, digits]);
}

/** "40.0 L": a fill's amount as stored, one decimal, in the reader's digits. */
export function useFuelAmount() {
  const short = useFuelUnitShort();
  const decimal = useDecimal();
  return (amount: string, unit: FuelUnit) => `${decimal(amount, 1)} ${short[unit]}`;
}

/** The reader's unit system (Settings → Units); metric until the profile has loaded. */
export function useUnitSystem(): UnitSystem {
  const me = useMe();
  return me.data?.profile.units ?? 'metric';
}

/**
 * A consumption ("7.3 L/100 km", "32.2 mpg", "1.6 L/h") from the summary's `perHundred`, in the
 * reader's units.
 */
export function useConsumptionText() {
  const { t } = useLingui();
  const units = useUnitSystem();
  const decimal = useDecimal();
  const short = useFuelUnitShort();
  return (perHundred: string, fuelUnit: FuelUnit, distanceUnit: string): string => {
    const d = displayConsumption(perHundred, fuelUnit, distanceUnit, units);
    const v = decimal(d.value, 1);
    switch (d.unit) {
      case 'L/100 km':
        return t`${v} L/100 km`;
      case 'kWh/100 km':
        return t`${v} kWh/100 km`;
      case 'mpg':
        return t`${v} mpg`;
      case 'mi/kWh':
        return t`${v} mi/kWh`;
      default: {
        if (d.unit === `${fuelUnit}/h`) {
          const u = short[fuelUnit];
          return t`${v} ${u} an hour`;
        }
        return `${v} ${d.unit}`;
      }
    }
  };
}

/** Why the summary has no consumption, in words (the server's `whyNone`). */
export function useWhyNoneText(): (why: ConsumptionWhyNone | undefined) => string {
  const { t } = useLingui();
  return (why) => {
    switch (why) {
      case 'missed_fill':
        return t`A missed fill-up breaks the count. Consumption shows again after two full fills with odometer readings.`;
      case 'mixed_units':
        return t`Consumption needs two full fills in the same unit, with no fill in another unit between them.`;
      case 'no_readings':
        return t`Consumption needs the odometer on the fills. Add it when you log fuel.`;
      default:
        return t`Consumption needs two full fills with odometer readings.`;
    }
  };
}
