import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { withErrorBoundary } from './ErrorBoundary';

function Thrower({ fail }: { fail: boolean }) {
  if (fail) throw new Error('Illegal value for token color');
  return <div>fine</div>;
}

describe('withErrorBoundary', () => {
  it('renders the panel, or a contained fallback with the error instead of unmounting everything', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Bounded = withErrorBoundary(Thrower, 'The diff panel');
    render(
      <>
        <Bounded fail />
        <div>sibling</div>
      </>,
    );
    expect(screen.getByTestId('panel-error')).toHaveTextContent('The diff panel failed');
    expect(screen.getByTestId('panel-error')).toHaveTextContent('Illegal value for token color');
    expect(screen.getByText('sibling')).toBeInTheDocument();
    spy.mockRestore();
  });
});
