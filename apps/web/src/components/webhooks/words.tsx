/**
 * Webhooks' words (D63, D110, D172, engineering spec §2.6): each event in plain words, a
 * delivery's state, and why a webhook was switched off (D180).
 */
import type { WebhookDeliveryStatus, WebhookDisabledReason, WebhookEvent } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { useCallback } from 'react';

export function useEventWords() {
  const { t } = useLingui();
  return useCallback(
    (event: WebhookEvent | 'ping') => {
      switch (event) {
        case 'thing.created':
          return t`A thing is added`;
        case 'thing.updated':
          return t`A thing is changed`;
        case 'thing.moved':
          return t`A thing is moved`;
        case 'thing.trashed':
          return t`A thing goes to Trash`;
        case 'thing.restored':
          return t`A thing comes back from Trash`;
        case 'thing.lifecycle_changed':
          return t`A thing's state changes, such as lost or sold`;
        case 'reading.logged':
          return t`A meter reading is logged`;
        case 'reminder.due':
          return t`A reminder is due`;
        case 'ping':
          return t`Test`;
      }
    },
    [t],
  );
}

export function useDeliveryWords() {
  const { t } = useLingui();
  return useCallback(
    (status: WebhookDeliveryStatus) => {
      switch (status) {
        case 'delivered':
          return t`Delivered`;
        case 'pending':
          return t`Waiting to send`;
        case 'failed':
          return t`Failed, trying again`;
        case 'gave_up':
          return t`Gave up`;
      }
    },
    [t],
  );
}

export function useDisabledWords() {
  const { t } = useLingui();
  return useCallback(
    (reason: WebhookDisabledReason) => {
      switch (reason) {
        case 'creator_lost_role':
          return t`Off: the person who made it is no longer an admin here.`;
        case 'failing':
          return t`Off: every delivery failed for a day.`;
        case 'admin':
          return t`Turned off by an admin.`;
      }
    },
    [t],
  );
}
