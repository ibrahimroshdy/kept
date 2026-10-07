import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/settings/account/')({
  beforeLoad: ({ search }) => {
    const account = (search as { account?: string }).account;
    throw redirect({
      to: '/settings/account/types',
      search: (account ? { account } : {}) as never,
      replace: true,
    });
  },
});
