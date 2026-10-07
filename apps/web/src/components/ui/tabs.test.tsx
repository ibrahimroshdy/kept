import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { Tab, TabList, TabPanel, Tabs } from './tabs';

function Example({ names }: { names: [string, string, string] }) {
  return (
    <Tabs>
      <TabList aria-label="Settings">
        <Tab id="a">{names[0]}</Tab>
        <Tab id="b">{names[1]}</Tab>
        <Tab id="c">{names[2]}</Tab>
      </TabList>
      <TabPanel id="a">Panel A</TabPanel>
      <TabPanel id="b">Panel B</TabPanel>
      <TabPanel id="c">Panel C</TabPanel>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('renders a tablist with the first tab selected', async () => {
    await renderUI(<Example names={['Members', 'What to track', 'Danger zone']} />);
    expect(screen.getByRole('tab', { name: 'Members' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel A');
  });

  it('moves with the arrow keys (LTR: ArrowRight is next)', async () => {
    const { user } = await renderUI(
      <Example names={['Members', 'What to track', 'Danger zone']} />,
    );
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'What to track' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel B');
  });

  it('mirrors in RTL: ArrowLeft is next', async () => {
    const { user } = await renderUI(
      <Example names={['الأعضاء', 'ما الذي تتابعه', 'منطقة الخطر']} />,
      {
        locale: 'ar',
      },
    );
    await user.tab();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'ما الذي تتابعه' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expectLogicalOnly();
  });
});
