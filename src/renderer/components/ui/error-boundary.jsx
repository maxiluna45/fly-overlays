import React from "react";

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[ErrorBoundary]", error.message, info.componentStack);
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-full flex flex-col items-center justify-center p-6 text-center bg-background text-foreground gap-2">
          <div className="text-sm font-semibold text-red-400">
            Algo se rompió al renderizar este overlay
          </div>
          <div className="text-xs text-muted-foreground max-w-md font-mono">
            {this.state.error.message}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-3 px-3 py-1 rounded-md bg-accent text-accent-foreground text-xs cursor-pointer"
          >
            Reintentar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
