/**
 * Location settings → Share links (1.5, D233; screens §5 Share links): the location's read-only
 * links, their state and views, Preview as recipient, and Revoke. Owners and admins only (the tab
 * is hidden for others and in Personal; the frame says so if they come by link). Its chunk loads
 * on demand (vite.config.ts); its error screen stays precached, so offline it says "Needs a
 * connection".
 */
import { useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { LocationSettingsPage } from '@/components/location-settings';
import { SettingsRouteError } from '@/components/on-demand-route-error';
import { SHARE_LINK_FILTERS, ShareLinksList } from '@/components/sharelinks/list';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/settings/location/$id/share-links')({
  validateSearch: listSearch(SHARE_LINK_FILTERS),
  component: ShareLinksPage,
  errorComponent: SettingsRouteError,
});

function ShareLinksPage() {
  const { id } = Route.useParams();
  const { t } = useLingui();
  return (
    <LocationSettingsPage id={id} section="share-links" title={() => t`Share links`}>
      {() => <ShareLinksList locationId={id} />}
    </LocationSettingsPage>
  );
}
