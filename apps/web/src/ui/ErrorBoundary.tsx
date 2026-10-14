import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Rendered instead of the children after an error; `reset` renders them again. */
  fallback: (error: Error, reset: () => void) => ReactNode;
  /** Called once per caught error (e.g. to close a dialog and toast). */
  onError?: (error: Error, info: ErrorInfo) => void;
}

/** Catches render errors (including failed lazy chunk imports) below it. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack);
    this.props.onError?.(error, info);
  }

  reset = (): void => this.setState({ error: null });

  override render(): ReactNode {
    return this.state.error
      ? this.props.fallback(this.state.error, this.reset)
      : this.props.children;
  }
}
