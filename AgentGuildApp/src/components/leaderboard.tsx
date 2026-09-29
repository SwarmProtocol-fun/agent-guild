/** Leaderboard — Ranked list of top-performing agents by task completion and efficiency. */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
const medals = ["🥇", "🥈", "🥉"];

interface AgentPerformance {
  agentId: string;
  name: string;
  type: string;
  winRate: number;
  pnl: number;
}

interface LeaderboardProps {
  agents: AgentPerformance[];
  currency?: string;
  limit?: number;
  compact?: boolean;
}

export function Leaderboard({ agents: rawAgents, currency = "$", limit = 6, compact = false }: LeaderboardProps) {
  const agents = [...rawAgents]
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, limit);

  const maxPnl = Math.max(...agents.map((a) => Math.abs(a.pnl)));

  return (
    <Card>
      <CardHeader className={cn("flex flex-row items-center justify-between", compact && "pb-3")}>
        <CardTitle className={cn(compact ? "text-lg" : "text-xl")}>
          🏆 Top Agents
        </CardTitle>
        <Badge className="bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 text-xs">
          By P&L
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {agents.map((agent, i) => {
          const isPositive = agent.pnl >= 0;
          const barWidth = (Math.abs(agent.pnl) / maxPnl) * 100;

          return (
            <div
              key={agent.agentId}
              className={cn(
                "flex items-center gap-3 py-2 rounded-md transition-colors",
                !compact && "px-3 hover:bg-muted"
              )}
            >
              <span className="text-lg w-7 text-center flex-shrink-0">
                {i < 3 ? medals[i] : <span className="text-sm text-muted-foreground font-medium">#{i + 1}</span>}
              </span>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">{agent.name}</span>
                    {!compact && (
                      <span className="text-xs text-muted-foreground">{agent.type}</span>
                    )}
                  </div>
                  <span
                    className={cn(
                      "font-semibold text-sm tabular-nums",
                      isPositive ? "text-amber-600 dark:text-amber-400" : "text-red-500"
                    )}
                  >
                    {isPositive ? "+" : "-"}
                    {`$${Math.abs(agent.pnl).toLocaleString()}`}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        isPositive ? "bg-amber-600" : "bg-red-400"
                      )}
                      style={{ width: `${barWidth}%` }}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground w-12 text-right">
                    {agent.winRate.toFixed(1)}%
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
