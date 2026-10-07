/**
 * Mock handlers for the calendar feed's links (T17; D142, D181; Q23). A new link's URL is shown
 * once; at most 3 live; revoking keeps the row (with `revokedAt`) so the list can say so. The
 * public `GET /cal/:token.ics` is the server's alone: the app never fetches it.
 */
import { MAX_CALENDAR_FEEDS } from '@kept/shared';
import { now } from '../../inventory/mock/db';
import type { MockState } from '../../mock/fixtures';
import { err, type MockRoute, notFound, reply, route } from '../../mock/kit';
import { householdPaths as p } from '../paths';
import { hh, newId } from './db';

export function calendarRoutes(state: MockState): MockRoute[] {
  const h = () => hh(state);
  return [
    route('GET', p.calendarFeeds, () => ({ items: h().calendarFeeds })),
    route('POST', p.calendarFeeds, () => {
      if (h().calendarFeeds.filter((f) => !f.revokedAt).length >= MAX_CALENDAR_FEEDS)
        return err(409, 'conflict', `At most ${MAX_CALENDAR_FEEDS} calendar links.`);
      const id = newId();
      h().calendarFeeds.push({
        id,
        createdAt: now(),
        lastFetchedAt: null,
        fetches: 0,
        revokedAt: null,
      });
      const origin = typeof location === 'undefined' ? 'http://kept.test' : location.origin;
      return reply(201, { id, url: `${origin}/cal/mock-${id.slice(-12)}.ics` });
    }),
    route('DELETE', p.calendarFeed(':id'), ({ params }) => {
      const feed = h().calendarFeeds.find((f) => f.id === params.id && !f.revokedAt);
      if (!feed) return notFound();
      feed.revokedAt = now();
      return reply(204);
    }),
  ];
}
