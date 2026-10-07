import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { expectLogicalOnly, renderUI } from '@/test/render';
import { Button } from './button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './card';

function Example({ title, place }: { title: string; place: string }) {
  const onPress = vi.fn();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{place}</CardDescription>
      </CardHeader>
      <CardContent>
        <span className="tape">K7-3QF</span>
      </CardContent>
      <CardFooter>
        <Button size="small" onPress={onPress}>
          Open
        </Button>
      </CardFooter>
    </Card>
  );
}

describe('Card', () => {
  it('renders its title as a heading, with the description', async () => {
    await renderUI(<Example title="Cordless drill" place="Garage" />);
    expect(screen.getByRole('heading', { name: 'Cordless drill' })).toBeInTheDocument();
    expect(screen.getByText('Garage')).toBeInTheDocument();
  });

  it('adds no tab stops of its own: Tab goes straight to its action', async () => {
    const { user } = await renderUI(<Example title="Cordless drill" place="Garage" />);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
  });

  it('renders RTL; the short ID stays left-to-right', async () => {
    await renderUI(<Example title="مثقاب لاسلكي" place="المرآب" />, { locale: 'ar' });
    expect(screen.getByRole('heading', { name: 'مثقاب لاسلكي' })).toBeInTheDocument();
    expectLogicalOnly();
  });
});
