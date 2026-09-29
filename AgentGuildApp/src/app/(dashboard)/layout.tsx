/** Layout for Dashboard App — wraps pages with Header, Sidebar, and ProtectedRoute.
 *  Uses DashboardShell for skin-aware layout switching (e.g., JRPG mode). */
import { ProtectedRoute } from "@/components/protected-route";
import { DashboardShell } from "@/components/dashboard-shell";
import { DashboardErrorBoundary } from "@/components/dashboard-error-boundary";

export default function DashboardAppLayout({ children }: { children: React.ReactNode }) {
    return (
        <ProtectedRoute>
            <DashboardShell>
                <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
            </DashboardShell>
        </ProtectedRoute>
    );
}
