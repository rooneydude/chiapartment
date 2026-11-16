import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Shown in place of the children once one of them has thrown. */
  fallback: (error: Error) => ReactNode;
  /** When this changes the boundary forgets its error (a new route, another building). */
  resetKey?: unknown;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Keeps one broken part of a page from emptying the whole app. Without it a
 * single render error — WebGL refusing to start, a chunk that failed to
 * download — unmounts everything down to a white page.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render(): ReactNode {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

/** Fallback for one panel of a page: the rest of the page keeps working. */
export function PanelFallback({ what, error }: { what: string; error: Error }) {
  return (
    <div className="panel-fallback" role="status">
      <strong>{what} could not be shown.</strong>
      <span>
        Everything else on this page still works. ({error.message || "unknown error"})
      </span>
      <button className="retry-btn" onClick={() => window.location.reload()}>
        Reload the page
      </button>
    </div>
  );
}
