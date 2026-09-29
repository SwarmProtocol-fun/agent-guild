/**
 * Command Center — Operational Health Dashboard
 *
 * Production-grade operator view focused on:
 * - System health & status
 * - Actionable alerts
 * - Agent fleet status
 *
 * Design philosophy: Truth, not features. What do I need to know and do right now?
 */
'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useOrg } from "@/contexts/OrgContext";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Shield,
  Users,
  TrendingUp,
  Loader2,
  AlertCircle,
  Wifi,
  WifiOff,
  FileText,
  Hash,
} from "lucide-react";
import { getAgentsByOrg, getTasksByOrg, type Agent, type Task } from "@/lib/firestore";
import { VitalsWidget } from "@/components/vitals-widget";

interface SystemHealth {
  status: 'healthy' | 'degraded' | 'critical';
  message: string;
  details: { label: string; value: string; status: 'ok' | 'warning' | 'error' }[];
}

export default function CommandCenterPage() {
  const { currentOrg } = useOrg();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);

  useEffect(() => {
    if (!currentOrg?.id) return;

    const load = async () => {
      setLoading(true);
      try {
        const [agentsData, tasksData] = await Promise.all([
          getAgentsByOrg(currentOrg.id),
          getTasksByOrg(currentOrg.id),
        ]);

        setAgents(agentsData);
        setTasks(tasksData);

        // Compute system health
        const onlineCount = agentsData.filter(a => a.status === 'online').length;
        const totalAgents = agentsData.length;
        const activeTasks = tasksData.filter(t => t.status === 'in_progress').length;
        const todoTasks = tasksData.filter(t => t.status === 'todo').length;
        const completionRate = tasksData.length > 0
          ? Math.round((tasksData.filter(t => t.status === 'done').length / tasksData.length) * 100)
          : 0;

        const healthStatus: 'healthy' | 'degraded' | 'critical' =
          onlineCount === 0 && totalAgents > 0 ? 'critical' :
          onlineCount < totalAgents * 0.5 ? 'degraded' :
          'healthy';

        setSystemHealth({
          status: healthStatus,
          message: healthStatus === 'healthy'
            ? 'All systems operational'
            : healthStatus === 'degraded'
            ? 'Some agents offline — fleet capacity reduced'
            : 'Critical: All agents offline',
          details: [
            {
              label: 'Agents Online',
              value: `${onlineCount}/${totalAgents}`,
              status: onlineCount === totalAgents ? 'ok' : onlineCount > 0 ? 'warning' : 'error',
            },
            {
              label: 'Active Tasks',
              value: `${activeTasks}`,
              status: 'ok',
            },
            {
              label: 'Completion',
              value: `${completionRate}%`,
              status: completionRate >= 70 ? 'ok' : completionRate >= 50 ? 'warning' : 'error',
            },
          ],
        });

      } catch (error) {
        console.error('Failed to load command center:', error);
      } finally {
        setLoading(false);
      }
    };

    load();
    // Refresh every 30s, but not while the tab is in the background
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 30000);
    return () => clearInterval(interval);
  }, [currentOrg?.id]);

  if (!currentOrg) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-center text-muted-foreground">
          Select an organization to view command center
        </div>
      </div>
    );
  }

  const ActionableItems = () => {
    const highPriorityTodo = tasks.filter(t =>
      t.status === 'todo' && t.priority === 'high'
    );
    const offlineAgents = agents.filter(a => a.status === 'offline');
    const needsAttention = highPriorityTodo.length + offlineAgents.length;

    return (
      <Card className="border-2">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-amber-500" />
              Action Required
            </CardTitle>
            <Badge variant={needsAttention > 0 ? "destructive" : "outline"}>
              {needsAttention} items
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {needsAttention === 0 ? (
            <div className="text-sm text-muted-foreground flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              No action items — you're all caught up
            </div>
          ) : (
            <>
              {highPriorityTodo.length > 0 && (
                <div className="space-y-2">
                  <div className="text-sm font-medium text-destructive flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" />
                    {highPriorityTodo.length} High-Priority Tasks
                  </div>
                  {highPriorityTodo.slice(0, 3).map(task => (
                    <Link key={task.id} href={`/kanban`}>
                      <div className="text-xs p-2 rounded bg-destructive/10 hover:bg-destructive/20 transition-colors">
                        <div className="font-medium">{task.title}</div>
                        <div className="text-muted-foreground text-[10px]">
                          Priority: {task.priority.toUpperCase()}
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
              {offlineAgents.length > 0 && (
                <div className="space-y-2">
                  <div className="text-sm font-medium text-amber-600 flex items-center gap-2">
                    <WifiOff className="h-4 w-4" />
                    {offlineAgents.length} Agents Offline
                  </div>
                  <Link href="/agents">
                    <Button variant="outline" size="sm" className="w-full">
                      View Agent Status →
                    </Button>
                  </Link>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    );
  };


  const AgentFleetStatus = () => {
    const online = agents.filter(a => a.status === 'online').length;
    const busy = agents.filter(a => a.status === 'busy').length;
    const offline = agents.filter(a => a.status === 'offline').length;

    return (
      <Card className="border-2">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Users className="h-5 w-5" />
            Agent Fleet
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="p-3 rounded bg-emerald-500/10">
                <div className="text-2xl font-bold text-emerald-600">{online}</div>
                <div className="text-xs text-muted-foreground">Online</div>
              </div>
              <div className="p-3 rounded bg-amber-500/10">
                <div className="text-2xl font-bold text-amber-600">{busy}</div>
                <div className="text-xs text-muted-foreground">Busy</div>
              </div>
              <div className="p-3 rounded bg-muted">
                <div className="text-2xl font-bold">{offline}</div>
                <div className="text-xs text-muted-foreground">Offline</div>
              </div>
            </div>

            <Link href="/agents">
              <Button variant="outline" size="sm" className="w-full">
                Manage Fleet →
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Command Center</h1>
            <p className="text-muted-foreground">Operational health and actionable intelligence</p>
          </div>
          <Link href="/dashboard">
            <Button variant="outline" size="sm">
              Analytics Dashboard →
            </Button>
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* System Health Status */}
          <Card className={`border-2 ${
            systemHealth?.status === 'healthy' ? 'border-emerald-500/50 bg-emerald-500/5' :
            systemHealth?.status === 'degraded' ? 'border-amber-500/50 bg-amber-500/5' :
            'border-destructive/50 bg-destructive/5'
          }`}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-xl flex items-center gap-3">
                  {systemHealth?.status === 'healthy' ? (
                    <CheckCircle2 className="h-6 w-6 text-emerald-500" />
                  ) : systemHealth?.status === 'degraded' ? (
                    <AlertTriangle className="h-6 w-6 text-amber-500" />
                  ) : (
                    <XCircle className="h-6 w-6 text-destructive" />
                  )}
                  System Health
                </CardTitle>
                <Badge
                  variant={systemHealth?.status === 'healthy' ? 'outline' : 'destructive'}
                  className={
                    systemHealth?.status === 'healthy' ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' :
                    systemHealth?.status === 'degraded' ? 'bg-amber-500/10 text-amber-600 border-amber-500/20' :
                    ''
                  }
                >
                  {systemHealth?.status.toUpperCase()}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground mt-2">{systemHealth?.message}</p>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4">
                {systemHealth?.details.map((detail, i) => (
                  <div key={i} className="text-center p-4 rounded bg-background">
                    <div className={`text-2xl font-bold ${
                      detail.status === 'ok' ? 'text-emerald-600' :
                      detail.status === 'warning' ? 'text-amber-600' :
                      'text-destructive'
                    }`}>
                      {detail.value}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">{detail.label}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Main Grid */}
          <ActionableItems />

          <div className="grid lg:grid-cols-2 gap-6">
            <AgentFleetStatus />
            <Card className="border-2">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Activity className="h-5 w-5" />
                  System Vitals
                </CardTitle>
              </CardHeader>
              <CardContent>
                <VitalsWidget />
              </CardContent>
            </Card>
          </div>

          {/* Quick Links */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Quick Actions</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Link href="/agents/register">
                  <Button variant="outline" className="w-full" size="sm">
                    Register Agent
                  </Button>
                </Link>
                <Link href="/tasks">
                  <Button variant="outline" className="w-full" size="sm">
                    View Tasks
                  </Button>
                </Link>
                <Link href="/doctor">
                  <Button variant="outline" className="w-full" size="sm">
                    System Diagnostics
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
