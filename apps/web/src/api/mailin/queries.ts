/**
 * Email-in's fetchers, key and hook (1.4, D231) over ./types.ts and ./paths.ts.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../client';
import { mailinPaths as p } from './paths';
import type { Mailbox, MailboxBody, MailboxCheck, MailboxResponse } from './types';

export const mailinKeys = {
  mailbox: (locationId: string) => ['mailin', 'mailbox', locationId] as const,
};

export const mailinApi = {
  mailbox: (locationId: string) => api.get<MailboxResponse>(p.mailbox(locationId)),
  saveMailbox: (locationId: string, body: MailboxBody) =>
    api.put<Mailbox>(p.mailbox(locationId), body),
  checkMailbox: (locationId: string) => api.post<MailboxCheck>(p.mailboxCheck(locationId)),
  removeMailbox: (locationId: string) => api.del(p.mailbox(locationId)),
};

export function useMailbox(locationId: string) {
  return useQuery({
    queryKey: mailinKeys.mailbox(locationId),
    queryFn: () => mailinApi.mailbox(locationId),
  });
}
