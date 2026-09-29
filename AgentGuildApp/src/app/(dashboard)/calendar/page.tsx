/** Calendar — Schedule view for tasks, cron jobs, and agent activity across dates. */
"use client";

import { useState, useEffect, useMemo } from "react";
import { useOrg } from "@/contexts/OrgContext";
import { motion } from "motion/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import SpotlightCard from "@/components/reactbits/SpotlightCard";
import {
    getTasksByOrg,
    getJobsByOrg,
    getProjectsByOrg,
    getAgentsByOrg,
    type Task,
    type Job,
    type Project,
    type Agent,
} from "@/lib/firestore";

// ─── Helpers ─────────────────────────────────────────

function tsToDate(ts: unknown): Date | null {
    if (!ts) return null;
    if (ts && typeof ts === "object" && "seconds" in ts) {
        return new Date((ts as { seconds: number }).seconds * 1000);
    }
    return new Date(ts as string | number);
}

function isSameDay(a: Date, b: Date) {
    return a.getFullYear() === b.getFullYear()
        && a.getMonth() === b.getMonth()
        && a.getDate() === b.getDate();
}

function getDaysInMonth(year: number, month: number) {
    return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number) {
    return new Date(year, month, 1).getDay();
}

const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

const DAY_HEADERS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const priorityColors: Record<string, string> = {
    low: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    medium: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
    high: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
};

interface CalendarEvent {
    id: string;
    title: string;
    date: Date;
    type: "task" | "job";
    status: string;
    priority: string;
    projectName: string;
    agentName?: string;
}

// ─── Component ───────────────────────────────────────

export default function CalendarPage() {
    const { currentOrg } = useOrg();
    const [tasks, setTasks] = useState<Task[]>([]);
    const [jobs, setJobs] = useState<Job[]>([]);
    const [projects, setProjects] = useState<Project[]>([]);
    const [agents, setAgents] = useState<Agent[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedDay, setSelectedDay] = useState<Date | null>(null);

    // Current month state
    const today = new Date();
    const [viewYear, setViewYear] = useState(today.getFullYear());
    const [viewMonth, setViewMonth] = useState(today.getMonth());

    useEffect(() => {
        if (!currentOrg) return;
        setLoading(true);

        Promise.all([
            getTasksByOrg(currentOrg.id),
            getJobsByOrg(currentOrg.id),
            getProjectsByOrg(currentOrg.id),
            getAgentsByOrg(currentOrg.id),
        ]).then(([t, j, p, a]) => {
            setTasks(t);
            setJobs(j);
            setProjects(p);
            setAgents(a);
            setLoading(false);
        }).catch(() => setLoading(false));
    }, [currentOrg]);

    // Build events from tasks and jobs
    const events = useMemo<CalendarEvent[]>(() => {
        const projectMap = new Map(projects.map(p => [p.id, p.name]));
        const agentMap = new Map(agents.map(a => [a.id, a.name]));

        const taskEvents: CalendarEvent[] = tasks
            .map(t => {
                const d = tsToDate(t.createdAt);
                if (!d) return null;
                return {
                    id: t.id,
                    title: t.title,
                    date: d,
                    type: "task" as const,
                    status: t.status,
                    priority: t.priority,
                    projectName: projectMap.get(t.projectId) || "Unknown",
                    agentName: t.assigneeAgentId ? agentMap.get(t.assigneeAgentId) || undefined : undefined,
                };
            })
            .filter(Boolean) as CalendarEvent[];

        const jobEvents: CalendarEvent[] = jobs
            .map(j => {
                const d = tsToDate(j.createdAt);
                if (!d) return null;
                return {
                    id: j.id,
                    title: j.title,
                    date: d,
                    type: "job" as const,
                    status: j.status,
                    priority: j.priority,
                    projectName: projectMap.get(j.projectId) || "Unknown",
                };
            })
            .filter(Boolean) as CalendarEvent[];

        return [...taskEvents, ...jobEvents].sort((a, b) => a.date.getTime() - b.date.getTime());
    }, [tasks, jobs, projects, agents]);

    // Events for selected day
    const selectedDayEvents = useMemo(() => {
        if (!selectedDay) return [];
        return events.filter(e => isSameDay(e.date, selectedDay));
    }, [events, selectedDay]);

    // Grid helpers
    const daysInMonth = getDaysInMonth(viewYear, viewMonth);
    const firstDay = getFirstDayOfMonth(viewYear, viewMonth);

    function prevMonth() {
        if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
        else setViewMonth(m => m - 1);
        setSelectedDay(null);
    }

    function nextMonth() {
        if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
        else setViewMonth(m => m + 1);
        setSelectedDay(null);
    }

    function goToday() {
        setViewYear(today.getFullYear());
        setViewMonth(today.getMonth());
        setSelectedDay(today);
    }

    if (!currentOrg) {
        return (
            <div className="space-y-6">
                <p className="text-muted-foreground mt-1">No organization selected</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-end gap-2">
                <Button variant="outline" size="sm" onClick={prevMonth}>←</Button>
                <span className="text-sm font-semibold min-w-[140px] text-center">
                    {MONTH_NAMES[viewMonth]} {viewYear}
                </span>
                <Button variant="outline" size="sm" onClick={nextMonth}>→</Button>
                <Button variant="outline" size="sm" onClick={goToday}>Today</Button>
            </div>

            {loading ? (
                <div className="text-center py-12 text-muted-foreground">Loading calendar...</div>
            ) : (
                <div className="flex gap-6">
                    {/* Calendar Grid */}
                    <motion.div
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.4 }}
                        className="flex-1"
                    >
                        {/* Day headers */}
                        <div className="grid grid-cols-7 mb-1">
                            {DAY_HEADERS.map(d => (
                                <div key={d} className="text-center text-xs font-medium text-muted-foreground py-2">{d}</div>
                            ))}
                        </div>

                        {/* Days grid */}
                        <div className="grid grid-cols-7 gap-1">
                            {/* Empty cells for offset */}
                            {Array.from({ length: firstDay }, (_, i) => (
                                <div key={`pad-${i}`} className="aspect-square" />
                            ))}

                            {/* Day cells */}
                            {Array.from({ length: daysInMonth }, (_, i) => {
                                const day = i + 1;
                                const cellDate = new Date(viewYear, viewMonth, day);
                                const isToday = isSameDay(cellDate, today);
                                const isSelected = selectedDay && isSameDay(cellDate, selectedDay);
                                const dayEvents = events.filter(e => isSameDay(e.date, cellDate));
                                const taskCount = dayEvents.filter(e => e.type === "task").length;
                                const jobCount = dayEvents.filter(e => e.type === "job").length;

                                return (
                                    <button
                                        key={day}
                                        onClick={() => setSelectedDay(cellDate)}
                                        className={`
                      aspect-square rounded-lg border p-1 text-left transition-all duration-200
                      hover:border-amber-500/50 hover:bg-amber-500/5 cursor-pointer
                      ${isToday ? "border-amber-500 bg-amber-500/10 ring-1 ring-amber-500/30" : "border-border bg-card"}
                      ${isSelected ? "ring-2 ring-amber-400 border-amber-400" : ""}
                    `}
                                    >
                                        <span className={`text-xs font-medium ${isToday ? "text-amber-600 dark:text-amber-400" : ""}`}>
                                            {day}
                                        </span>
                                        {dayEvents.length > 0 && (
                                            <div className="mt-0.5 flex flex-wrap gap-0.5">
                                                {taskCount > 0 && (
                                                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500" title={`${taskCount} task(s)`} />
                                                )}
                                                {jobCount > 0 && (
                                                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" title={`${jobCount} job(s)`} />
                                                )}
                                                {dayEvents.length > 2 && (
                                                    <span className="text-[9px] text-muted-foreground leading-none">+{dayEvents.length - 2}</span>
                                                )}
                                            </div>
                                        )}
                                    </button>
                                );
                            })}
                        </div>

                        {/* Legend */}
                        <div className="flex gap-4 mt-3 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" /> Tasks</span>
                            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" /> Jobs</span>
                        </div>
                    </motion.div>

                    {/* Day Detail Panel */}
                    <motion.div
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.3, delay: 0.15 }}
                        className="w-80 shrink-0"
                    >
                        <div className="rounded-xl border bg-card p-4 sticky top-6">
                            {selectedDay ? (
                                <>
                                    <h3 className="font-semibold text-sm mb-3">
                                        {selectedDay.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
                                    </h3>

                                    {selectedDayEvents.length === 0 ? (
                                        <p className="text-sm text-muted-foreground py-4 text-center">No events this day</p>
                                    ) : (
                                        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
                                            {selectedDayEvents.map(event => (
                                                <SpotlightCard key={event.id} className="p-0" spotlightColor="rgba(255,191,0,0.06)">
                                                    <div className="p-3 space-y-1.5">
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-xs">{event.type === "task" ? "🎯" : "💼"}</span>
                                                            <span className="text-sm font-medium truncate">{event.title}</span>
                                                        </div>
                                                        <div className="flex gap-1.5 flex-wrap">
                                                            <Badge variant="outline" className={`text-[10px] ${priorityColors[event.priority] || ""}`}>
                                                                {event.priority}
                                                            </Badge>
                                                            <Badge variant="outline" className="text-[10px]">
                                                                {event.status.replace("_", " ")}
                                                            </Badge>
                                                        </div>
                                                        <div className="text-xs text-muted-foreground">
                                                            📁 {event.projectName}
                                                            {event.agentName && <span> · 🤖 {event.agentName}</span>}
                                                        </div>
                                                    </div>
                                                </SpotlightCard>
                                            ))}
                                        </div>
                                    )}
                                </>
                            ) : (
                                <div className="text-center py-8 text-muted-foreground">
                                    <span className="text-3xl block mb-2">📅</span>
                                    <p className="text-sm">Click a day to see events</p>
                                </div>
                            )}
                        </div>
                    </motion.div>
                </div>
            )}
        </div>
    );
}
