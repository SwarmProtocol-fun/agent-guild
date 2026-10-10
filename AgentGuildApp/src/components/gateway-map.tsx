"use client";

import { useState } from "react";
import { Globe, Zap, Activity, TrendingUp, AlertCircle, CheckCircle } from "lucide-react";
import type { Gateway, GatewayRegion } from "@/lib/gateways";
import { REGION_LOCATIONS } from "@/lib/gateways";

interface GatewayMapProps {
  gateways: Gateway[];
  selectedGatewayId?: string;
  onSelect?: (gateway: Gateway) => void;
}

export function GatewayMap({ gateways, selectedGatewayId, onSelect }: GatewayMapProps) {
  const [hoveredRegion, setHoveredRegion] = useState<GatewayRegion | null>(null);

  // Group gateways by region
  const gatewaysByRegion = gateways.reduce((acc, gateway) => {
    const region = gateway.region || "us-east";
    if (!acc[region]) acc[region] = [];
    acc[region].push(gateway);
    return acc;
  }, {} as Record<GatewayRegion, Gateway[]>);

  const getRegionStatus = (region: GatewayRegion): "healthy" | "degraded" | "down" => {
    const regionGateways = gatewaysByRegion[region] || [];
    if (regionGateways.length === 0) return "down";

    const connectedCount = regionGateways.filter((g) => g.status === "connected").length;
    if (connectedCount === regionGateways.length) return "healthy";
    if (connectedCount > 0) return "degraded";
    return "down";
  };

  const getStatusColor = (status: ReturnType<typeof getRegionStatus>) => {
    switch (status) {
      case "healthy":
        return "bg-green-500";
      case "degraded":
        return "bg-yellow-500";
      case "down":
        return "bg-gray-500";
    }
  };

  return (
    <div className="space-y-6">
      {/* World Map Visualization (Simplified) */}
      <div className="bg-card rounded-lg p-6 border border-border">
        <div className="flex items-center gap-2 mb-4">
          <Globe className="w-5 h-5 text-blue-400" />
          <h3 className="text-lg font-semibold text-foreground">Global Gateway Network</h3>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {Object.entries(REGION_LOCATIONS).map(([region, location]) => {
            const status = getRegionStatus(region as GatewayRegion);
            const regionGateways = gatewaysByRegion[region as GatewayRegion] || [];
            const totalConnections = regionGateways.reduce(
              (sum, g) => sum + (g.metrics?.activeConnections || 0),
              0
            );

            return (
              <div
                key={region}
                className={`p-4 rounded-lg border transition cursor-pointer ${
                  hoveredRegion === region
                    ? "bg-muted/80 border-blue-500"
                    : "bg-muted border-border hover:bg-gray-750"
                }`}
                onMouseEnter={() => setHoveredRegion(region as GatewayRegion)}
                onMouseLeave={() => setHoveredRegion(null)}
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className={`w-2 h-2 rounded-full ${getStatusColor(status)}`} />
                  <span className="text-sm font-medium text-foreground">{location.name}</span>
                </div>

                <div className="text-xs text-muted-foreground space-y-1">
                  <div className="flex justify-between">
                    <span>Gateways:</span>
                    <span className="text-foreground">{regionGateways.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Connections:</span>
                    <span className="text-foreground">{totalConnections}</span>
                  </div>
                  {regionGateways.length > 0 && (
                    <div className="flex justify-between">
                      <span>Avg Latency:</span>
                      <span className="text-foreground">
                        {Math.round(
                          regionGateways.reduce((sum, g) => sum + (g.metrics?.avgLatencyMs || 0), 0) /
                            regionGateways.length
                        )}
                        ms
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Gateway List */}
      <div className="space-y-3">
        {gateways.map((gateway) => (
          <GatewayCard
            key={gateway.id}
            gateway={gateway}
            isSelected={gateway.id === selectedGatewayId}
            onSelect={() => onSelect?.(gateway)}
          />
        ))}

        {gateways.length === 0 && (
          <div className="text-center p-8 bg-muted rounded-lg border border-border">
            <Globe className="w-12 h-12 mx-auto text-gray-600 mb-3" />
            <p className="text-muted-foreground">No gateways configured</p>
          </div>
        )}
      </div>
    </div>
  );
}

interface GatewayCardProps {
  gateway: Gateway;
  isSelected: boolean;
  onSelect: () => void;
}

function GatewayCard({ gateway, isSelected, onSelect }: GatewayCardProps) {
  const statusColor =
    gateway.status === "connected"
      ? "bg-green-500"
      : gateway.status === "error"
      ? "bg-red-500"
      : "bg-gray-500";

  const uptimePercent = gateway.metrics?.uptime || 0;
  const loadPercent = gateway.capacity
    ? ((gateway.metrics?.activeConnections || 0) / gateway.capacity.maxConnections) * 100
    : 0;

  return (
    <div
      onClick={onSelect}
      className={`p-4 rounded-lg border transition cursor-pointer ${
        isSelected
          ? "bg-blue-500/10 border-blue-500"
          : "bg-muted border-border hover:bg-gray-750"
      }`}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${statusColor}`} />
          <div>
            <h4 className="font-medium text-foreground">{gateway.name}</h4>
            <p className="text-xs text-muted-foreground">
              {gateway.region ? REGION_LOCATIONS[gateway.region]?.name : "Unknown Region"}
            </p>
          </div>
        </div>

        {gateway.status === "connected" ? (
          <CheckCircle className="w-5 h-5 text-green-400" />
        ) : (
          <AlertCircle className="w-5 h-5 text-red-400" />
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div>
          <div className="flex items-center gap-1 text-muted-foreground mb-1">
            <Activity className="w-3 h-3" />
            <span>Connections</span>
          </div>
          <div className="text-foreground font-medium">
            {gateway.metrics?.activeConnections || 0}
            {gateway.capacity && ` / ${gateway.capacity.maxConnections}`}
          </div>
        </div>

        <div>
          <div className="flex items-center gap-1 text-muted-foreground mb-1">
            <Zap className="w-3 h-3" />
            <span>Latency</span>
          </div>
          <div className="text-foreground font-medium">{gateway.metrics?.avgLatencyMs || 0}ms</div>
        </div>

        <div>
          <div className="flex items-center gap-1 text-muted-foreground mb-1">
            <TrendingUp className="w-3 h-3" />
            <span>Uptime</span>
          </div>
          <div className="text-foreground font-medium">{uptimePercent.toFixed(1)}%</div>
        </div>

        <div>
          <div className="flex items-center gap-1 text-muted-foreground mb-1">
            <Activity className="w-3 h-3" />
            <span>Load</span>
          </div>
          <div className="text-foreground font-medium">{loadPercent.toFixed(0)}%</div>
        </div>
      </div>

      {gateway.lastHeartbeat && (
        <div className="mt-3 pt-3 border-t border-border text-xs text-muted-foreground">
          Last heartbeat: {new Date(gateway.lastHeartbeat).toLocaleString()}
        </div>
      )}
    </div>
  );
}
