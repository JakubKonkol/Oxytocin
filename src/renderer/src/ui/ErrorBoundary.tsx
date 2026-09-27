import { AlertTriangle } from 'lucide-react';
import { Component, type ComponentType, type FunctionComponent, type ReactNode } from 'react';
import { Button } from './Button';
import { EmptyState } from './EmptyState';

interface Props {
  /** Shown in the fallback ("The diff panel failed"). */
  label: string;
  children: ReactNode;
}

/** Contains a render error to one panel instead of unmounting the whole window. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center bg-card" data-testid="panel-error">
        <EmptyState
          icon={<AlertTriangle size={28} />}
          title={`${this.props.label} failed`}
          description={this.state.error.message}
          actions={
            <Button variant="secondary" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }
}

/** Wraps a panel component in an ErrorBoundary. */
export function withErrorBoundary<P extends object>(Inner: ComponentType<P>, label: string): FunctionComponent<P> {
  function Bounded(props: P) {
    return (
      <ErrorBoundary label={label}>
        <Inner {...props} />
      </ErrorBoundary>
    );
  }
  Bounded.displayName = `Bounded(${Inner.displayName ?? Inner.name})`;
  return Bounded;
}
