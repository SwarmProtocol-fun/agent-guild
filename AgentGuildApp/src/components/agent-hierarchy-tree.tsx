"use client";

import { useState } from "react";
import { ChevronRight, ChevronDown, Users, UserPlus, UserMinus, ArrowRight } from "lucide-react";
import type { AgentNode } from "@/lib/agent-hierarchy";
import type { Agent } from "@/lib/firestore";

interface AgentHierarchyTreeProps {
  rootNode: AgentNode;
  orgId: string;
  allAgents: Agent[];
  onAddChild?: (parentId: string, childId: string) => Promise<void>;
  onRemoveChild?: (parentId: string, childId: string) => Promise<void>;
  onDelegate?: (parentId: string, childId: string) => Promise<void>;
}

export function AgentHierarchyTree({
  rootNode,
  orgId,
  allAgents,
  onAddChild,
  onRemoveChild,
  onDelegate,
}: AgentHierarchyTreeProps) {
  return (
    <div className="space-y-2">
      <AgentTreeNode
        node={rootNode}
        orgId={orgId}
        allAgents={allAgents}
        onAddChild={onAddChild}
        onRemoveChild={onRemoveChild}
        onDelegate={onDelegate}
      />
    </div>
  );
}

interface AgentTreeNodeProps {
  node: AgentNode;
  orgId: string;
  allAgents: Agent[];
  onAddChild?: (parentId: string, childId: string) => Promise<void>;
  onRemoveChild?: (parentId: string, childId: string) => Promise<void>;
  onDelegate?: (parentId: string, childId: string) => Promise<void>;
}

function AgentTreeNode({
  node,
  orgId,
  allAgents,
  onAddChild,
  onRemoveChild,
  onDelegate,
}: AgentTreeNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const [showAddChild, setShowAddChild] = useState(false);
  const [selectedChildId, setSelectedChildId] = useState("");
  const [loading, setLoading] = useState(false);

  const hasChildren = node.children.length > 0;

  // Get agents that can be added as children (not already children, not self, not ancestors)
  const availableAgents = allAgents.filter(
    (a) =>
      a.id !== node.agent.id &&
      !node.agent.childAgentIds?.includes(a.id) &&
      a.orgId === orgId
  );

  const handleAddChild = async () => {
    if (!selectedChildId || !onAddChild) return;
    setLoading(true);
    try {
      await onAddChild(node.agent.id, selectedChildId);
      setShowAddChild(false);
      setSelectedChildId("");
    } catch (err) {
      console.error("Failed to add child:", err);
      alert(err instanceof Error ? err.message : "Failed to add child agent");
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveChild = async (childId: string) => {
    if (!onRemoveChild) return;
    if (!confirm("Remove this child agent from the hierarchy?")) return;

    setLoading(true);
    try {
      await onRemoveChild(node.agent.id, childId);
    } catch (err) {
      console.error("Failed to remove child:", err);
      alert(
        err instanceof Error ? err.message : "Failed to remove child agent"
      );
    } finally {
      setLoading(false);
    }
  };

  const handleDelegate = async (childId: string) => {
    if (!onDelegate) return;
    setLoading(true);
    try {
      await onDelegate(node.agent.id, childId);
      alert("Task delegation created successfully");
    } catch (err) {
      console.error("Failed to delegate:", err);
      alert(err instanceof Error ? err.message : "Failed to delegate task");
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (status: Agent["status"]) => {
    switch (status) {
      case "online":
        return "bg-green-500";
      case "busy":
        return "bg-yellow-500";
      case "paused":
        return "bg-orange-500";
      case "offline":
        return "bg-gray-500";
      default:
        return "bg-gray-500";
    }
  };

  return (
    <div className="select-none">
      {/* Node header */}
      <div className="flex items-center gap-2 p-3 bg-gray-800 rounded-lg border border-gray-700 hover:bg-gray-750 transition">
        {/* Expand/collapse button */}
        {hasChildren && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1 hover:bg-gray-700 rounded transition"
          >
            {expanded ? (
              <ChevronDown className="w-4 h-4 text-gray-400" />
            ) : (
              <ChevronRight className="w-4 h-4 text-gray-400" />
            )}
          </button>
        )}

        {/* Agent info */}
        <div className="flex items-center gap-3 flex-1">
          <div className={`w-2 h-2 rounded-full ${getStatusColor(node.agent.status)}`} />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-white">{node.agent.name}</span>
              <span className="text-xs text-gray-400 capitalize">
                {node.agent.type}
              </span>
              {node.agent.canDelegate && (
                <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded">
                  Can Delegate
                </span>
              )}
            </div>
            <div className="text-xs text-gray-500">
              Level {node.agent.hierarchyLevel} • {hasChildren ? `${node.children.length} child${node.children.length > 1 ? "ren" : ""}` : "No children"}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAddChild(!showAddChild)}
              disabled={loading}
              className="p-2 hover:bg-gray-700 rounded transition text-gray-400 hover:text-white disabled:opacity-50"
              title="Add child agent"
            >
              <UserPlus className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Add child form */}
      {showAddChild && (
        <div className="ml-6 mt-2 p-3 bg-gray-800/50 rounded-lg border border-gray-700">
          <div className="flex items-center gap-2">
            <select
              value={selectedChildId}
              onChange={(e) => setSelectedChildId(e.target.value)}
              disabled={loading}
              className="flex-1 bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
            >
              <option value="">Select an agent...</option>
              {availableAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} ({agent.type})
                </option>
              ))}
            </select>
            <button
              onClick={handleAddChild}
              disabled={!selectedChildId || loading}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded text-sm transition"
            >
              {loading ? "Adding..." : "Add"}
            </button>
            <button
              onClick={() => {
                setShowAddChild(false);
                setSelectedChildId("");
              }}
              disabled={loading}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white rounded text-sm transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Children */}
      {expanded && hasChildren && (
        <div className="ml-6 mt-2 space-y-2 border-l-2 border-gray-700 pl-4">
          {node.children.map((child) => (
            <div key={child.agent.id} className="relative">
              {/* Child node */}
              <AgentTreeNode
                node={child}
                orgId={orgId}
                allAgents={allAgents}
                onAddChild={onAddChild}
                onRemoveChild={onRemoveChild}
                onDelegate={onDelegate}
              />

              {/* Child actions */}
              <div className="absolute top-3 -left-4 flex gap-1">
                {onDelegate && node.agent.canDelegate && (
                  <button
                    onClick={() => handleDelegate(child.agent.id)}
                    disabled={loading}
                    className="p-1 bg-gray-800 border border-gray-700 hover:bg-gray-700 rounded transition text-blue-400 disabled:opacity-50"
                    title="Delegate task to this child"
                  >
                    <ArrowRight className="w-3 h-3" />
                  </button>
                )}
                {onRemoveChild && (
                  <button
                    onClick={() => handleRemoveChild(child.agent.id)}
                    disabled={loading}
                    className="p-1 bg-gray-800 border border-gray-700 hover:bg-gray-700 rounded transition text-red-400 disabled:opacity-50"
                    title="Remove child from hierarchy"
                  >
                    <UserMinus className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
