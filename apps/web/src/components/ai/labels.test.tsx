import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderUI } from '@/test/render';
import { useFailureReason } from './labels';

function Reason({ code }: { code: string }) {
  const why = useFailureReason();
  return <p>{why('provider_error', code)}</p>;
}

describe('useFailureReason', () => {
  it("names a request over the plan's per-minute limit (too_large), not a generic error", async () => {
    await renderUI(<Reason code="too_large" />);
    expect(
      screen.getByText('the request was more than the plan allows in one minute'),
    ).toBeInTheDocument();
  });

  it('keeps the generic line for an error code it does not know', async () => {
    await renderUI(<Reason code="something_new" />);
    expect(
      screen.queryByText('the request was more than the plan allows in one minute'),
    ).toBeNull();
  });
});
