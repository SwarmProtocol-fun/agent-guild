"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import SpotlightCard from "@/components/reactbits/SpotlightCard";
import { CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import DecryptedText from "@/components/reactbits/DecryptedText";
import { Clock, Play, Power, PowerOff } from "lucide-react";
import { Button } from "@/components/ui/button";

interface CronConfig {
    [taskId: string]: {
        active: boolean;
        description?: string;
        schedule: string;
        prompt: string;
        lastRun?: number;
        nextRun?: number;
    };
}

export function CronWidget() {
    const queryClient = useQueryClient();
    const { data: config = {}, isLoading: loading } = useQuery<CronConfig>({
        queryKey: ["cron-jobs"],
        queryFn: async () => {
            const res = await fetch("/api/cron-jobs");
            if (!res.ok) return {};
            const data = await res.json();
            return data.config ?? {};
        },
        refetchInterval: 30000,
        refetchIntervalInBackground: false,
    });

    const toggleCron = async (taskId: string, currentActive: boolean) => {
        try {
            // Optimistic update
            queryClient.setQueryData<CronConfig>(["cron-jobs"], (prev) => ({
                ...prev,
                [taskId]: { ...prev?.[taskId], active: !currentActive } as CronConfig[string],
            }));

            await fetch("/api/cron-jobs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "toggle", taskId, active: !currentActive })
            });
        } catch (err) {
            queryClient.invalidateQueries({ queryKey: ["cron-jobs"] }); // Revert on failure
        }
    };

    const triggerCron = async (taskId: string, prompt: string) => {
        try {
            await fetch("/api/cron-jobs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "trigger", taskId, prompt })
            });
        } catch (err) { }
    };

    const tasks = Object.entries(config);

    if (loading && tasks.length === 0) {
        return (
            <SpotlightCard className="p-0 glass-card-enhanced h-full overflow-hidden" spotlightColor="rgba(255, 191, 0, 0.06)">
                <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                        <Clock className="w-5 h-5 text-amber-500" />
                        <span className="text-lg font-semibold text-muted-foreground">Cron Jobs</span>
                    </CardTitle>
                </CardHeader>
                <CardContent className="h-40 flex items-center justify-center text-muted-foreground">
                    Loading schedules...
                </CardContent>
            </SpotlightCard>
        );
    }

    return (
        <SpotlightCard className="p-0 glass-card-enhanced h-full overflow-hidden" spotlightColor="rgba(255, 191, 0, 0.06)">
            <CardHeader className="pb-2">
                <CardTitle className="text-lg flex justify-between items-center">
                    <div className="flex items-center gap-2">
                        <Clock className="w-5 h-5 text-amber-500" />
                        <DecryptedText text="Scheduled Jobs" speed={30} maxIterations={6} animateOn="view" sequential className="text-lg font-semibold" encryptedClassName="text-lg font-semibold text-amber-500/40" />
                    </div>
                    <Badge variant="outline" className="text-[10px] bg-background/40 dark:bg-black/40">
                        {tasks.filter(t => t[1].active).length} Active
                    </Badge>
                </CardTitle>
            </CardHeader>

            <CardContent className="space-y-3 pt-2 max-h-64 overflow-y-auto custom-scrollbar">
                {tasks.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground text-sm">
                        <p>No cron jobs configured</p>
                        <p className="text-xs opacity-60 mt-1">Add tasks to CRON.json in workspace</p>
                    </div>
                ) : (
                    tasks.map(([id, task]) => (
                        <div key={id} className="bg-background/20 dark:bg-black/20 p-3 rounded-lg border border-border/60 flex flex-col gap-2 relative group hover:bg-black/30 transition-colors">
                            <div className="flex justify-between items-start gap-2">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2 max-w-full">
                                        <h4 className="font-semibold text-sm truncate">{id}</h4>
                                        <span className={`w-2 h-2 rounded-full shrink-0 ${task.active ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-muted-foreground/40'}`} />
                                    </div>
                                    {task.description && (
                                        <p className="text-xs text-muted-foreground truncate">{task.description}</p>
                                    )}
                                </div>

                                <div className="flex items-center gap-1 opacity-10 md:opacity-0 group-hover:opacity-100 transition-opacity absolute right-2 top-2 bg-black/80 rounded p-1">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-6 w-6 text-muted-foreground hover:text-amber-400"
                                        title="Trigger Now"
                                        onClick={() => triggerCron(id, task.prompt)}
                                    >
                                        <Play className="h-3 w-3" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className={`h-6 w-6 ${task.active ? 'text-red-400 hover:text-red-300' : 'text-emerald-400 hover:text-emerald-300'}`}
                                        title={task.active ? 'Disable Job' : 'Enable Job'}
                                        onClick={() => toggleCron(id, task.active)}
                                    >
                                        {task.active ? <PowerOff className="h-3 w-3" /> : <Power className="h-3 w-3" />}
                                    </Button>
                                </div>
                            </div>

                            <div className="flex items-center justify-between text-xs font-mono mt-1">
                                <div className="text-amber-500/80 bg-amber-500/10 px-1.5 py-0.5 rounded truncate">
                                    {task.schedule}
                                </div>
                                {task.nextRun && (
                                    <div className="text-muted-foreground truncate">
                                        Next: {new Date(task.nextRun).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' })}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))
                )}
            </CardContent>
        </SpotlightCard>
    );
}
