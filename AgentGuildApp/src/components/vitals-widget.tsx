/** Vitals Widget — 3 SVG circular gauges (CPU/RAM/Disk) with color-coded thresholds. */
"use client";

import { useQuery } from "@tanstack/react-query";
import { Cpu, HardDrive, MemoryStick, Server } from "lucide-react";
import { Card } from "@/components/ui/card";
import { vitalColor, vitalBg, fmtBytes, getLatestVitals } from "@/lib/vitals";
import { useOrg } from "@/contexts/OrgContext";

// ═══════════════════════════════════════════════════════════════
// Circular Gauge
// ═══════════════════════════════════════════════════════════════

function CircularGauge({ value, label, icon: Icon, detail }: {
    value: number; label: string; icon: typeof Cpu; detail?: string;
}) {
    const radius = 36;
    const stroke = 5;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (value / 100) * circumference;
    const color = vitalColor(value);
    const bg = vitalBg(value);

    return (
        <div className="flex flex-col items-center gap-2 min-w-0 shrink">
            <div className="relative w-20 h-20 sm:w-24 sm:h-24">
                <svg className="w-full h-full -rotate-90" viewBox="0 0 86 86">
                    <circle cx="43" cy="43" r={radius} fill="none" stroke="currentColor"
                        strokeWidth={stroke} className="text-muted/20" />
                    <circle cx="43" cy="43" r={radius} fill="none"
                        strokeWidth={stroke} strokeLinecap="round"
                        strokeDasharray={circumference} strokeDashoffset={offset}
                        className={bg} style={{ transition: "stroke-dashoffset 0.8s ease" }} />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <Icon className={`h-4 w-4 ${color} mb-0.5`} />
                    <span className={`text-lg font-bold ${color}`}>{value}%</span>
                </div>
            </div>
            <div className="text-center max-w-full">
                <p className="text-xs font-medium truncate">{label}</p>
                {detail && <p className="text-[9px] text-muted-foreground truncate">{detail}</p>}
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════
// Vitals Widget (for embedding on Dashboard)
// ═══════════════════════════════════════════════════════════════

interface VitalsData {
    cpu: { usage: number; chip?: string };
    memory: { usedBytes: number; totalBytes: number; percent: number };
    disk: { usedBytes: number; totalBytes: number; percent: number };
    hostname?: string;
    uptime?: string;
}

export function VitalsWidget({ data }: { data?: VitalsData | null }) {
    const { currentOrg } = useOrg();

    // Fetch real vitals when no data prop is provided, refreshing every 60s
    const { data: fetched, isLoading } = useQuery({
        queryKey: ["vitals", currentOrg?.id],
        queryFn: async () => {
            const v = await getLatestVitals(currentOrg!.id);
            if (!v) return null;
            return { cpu: v.cpu, memory: v.memory, disk: v.disk, hostname: v.hostname, uptime: v.uptime } as VitalsData;
        },
        enabled: data === undefined && !!currentOrg,
        refetchInterval: 60_000,
        refetchIntervalInBackground: false,
    });

    const vitals = data || fetched || null;

    return (
        <Card className="p-4 bg-card/80 border-border overflow-hidden">
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    <Server className="h-4 w-4 text-muted-foreground" />
                    <h3 className="text-sm font-semibold">System Vitals</h3>
                </div>
                <div className="flex items-center gap-2">
                    {vitals?.hostname && (
                        <span className="text-[9px] text-muted-foreground font-mono truncate ml-2">
                            {vitals.hostname} {vitals.uptime && `· ${vitals.uptime}`}
                        </span>
                    )}
                </div>
            </div>
            {!vitals ? (
                <p className="text-xs text-muted-foreground text-center py-6">
                    {isLoading ? "Loading vitals…" : "No vitals reported yet — connect a node to see live CPU, memory, and disk."}
                </p>
            ) : (
                <div className="flex justify-around gap-2 overflow-hidden">
                    <CircularGauge
                        value={vitals.cpu.usage}
                        label="CPU"
                        icon={Cpu}
                        detail={vitals.cpu.chip}
                    />
                    <CircularGauge
                        value={vitals.memory.percent}
                        label="Memory"
                        icon={MemoryStick}
                        detail={`${fmtBytes(vitals.memory.usedBytes)} / ${fmtBytes(vitals.memory.totalBytes)}`}
                    />
                    <CircularGauge
                        value={vitals.disk.percent}
                        label="Disk"
                        icon={HardDrive}
                        detail={`${fmtBytes(vitals.disk.usedBytes)} / ${fmtBytes(vitals.disk.totalBytes)}`}
                    />
                </div>
            )}
        </Card>
    );
}
