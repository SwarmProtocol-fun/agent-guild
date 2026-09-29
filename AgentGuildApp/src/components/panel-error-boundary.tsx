/** Panel Error Boundary — React class component wrapper that catches errors and shows a retry card. */
"use client";

import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface Props {
    label?: string;
    children: React.ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

/**
 * Crash-proof wrapper — if a child component throws, it shows
 * a friendly error card with a Retry button instead of crashing
 * the entire page.
 */
export class PanelErrorBoundary extends React.Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error(`[PanelErrorBoundary] ${this.props.label || "Panel"} crashed:`, error, info);
    }

    handleReset = () => {
        this.setState({ hasError: false, error: null });
    };

    render() {
        if (this.state.hasError) {
            return (
                <Card className="p-6 bg-card/80 border-red-500/20">
                    <div className="flex flex-col items-center text-center gap-3">
                        <div className="p-3 rounded-full bg-red-500/10">
                            <AlertTriangle className="h-6 w-6 text-red-400" />
                        </div>
                        <div>
                            <h3 className="text-sm font-semibold">Something went wrong</h3>
                            <p className="text-xs text-muted-foreground mt-1">
                                {this.props.label || "This section"} encountered an unexpected error.
                            </p>
                        </div>
                        {this.state.error && (
                            <details className="w-full text-left">
                                <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground">
                                    Error details
                                </summary>
                                <pre className="mt-2 p-2 rounded bg-muted/30 text-[10px] text-red-400 overflow-auto max-h-24 font-mono">
                                    {this.state.error.message}
                                </pre>
                            </details>
                        )}
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={this.handleReset}
                            className="mt-1 gap-1.5"
                        >
                            <RefreshCw className="h-3 w-3" />
                            Retry
                        </Button>
                    </div>
                </Card>
            );
        }
        return this.props.children;
    }
}
