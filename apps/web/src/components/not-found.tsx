import { Trans } from '@lingui/react/macro';
import { AuthFrame } from '@/components/auth-frame';
import { LinkButton } from '@/components/page';

export function NotFound() {
  return (
    <AuthFrame
      title={<Trans>Nothing here</Trans>}
      intro={<Trans>This address doesn't lead to a page in Kept. The link may be old.</Trans>}
      footer={
        <LinkButton to="/" variant="primary">
          <Trans>Go to Home</Trans>
        </LinkButton>
      }
    >
      {null}
    </AuthFrame>
  );
}
