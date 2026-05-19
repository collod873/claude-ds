"use client";
import React from "react";

interface Props {
  componentName: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ShowcaseBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-semibold text-destructive">{this.props.componentName} — render error</p>
          <p className="mt-1 font-mono text-xs text-destructive/80 break-all">
            {this.state.error.message}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Hint: backfill{" "}
            <code className="rounded bg-muted px-1">meta.examples</code> in{" "}
            <code className="rounded bg-muted px-1">
              design-system/&lt;tier&gt;/{this.props.componentName.toLowerCase()}.tsx
            </code>{" "}
            to render this component.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
