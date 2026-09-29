"use client";

import { useEffect, useState } from "react";
import { useOrg } from "@/contexts/OrgContext";
import { SummaryCard } from "@/components/summary-card";
import { type DailySummary } from "@/lib/daily-summary";
import { Calendar, RefreshCw, Download, Filter } from "lucide-react";

export default function SummariesPage() {
  const { currentOrg } = useOrg();
  const [summaries, setSummaries] = useState<DailySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterAgent, setFilterAgent] = useState<string>("");
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    if (!currentOrg?.id) return;
    fetchSummaries();
    fetchAgents();
  }, [currentOrg?.id]);

  async function fetchSummaries() {
    if (!currentOrg?.id) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/summaries?orgId=${currentOrg.id}&limit=50`);
      const json = await res.json();
      if (json.ok) {
        setSummaries(json.summaries);
      }
    } catch (err) {
      console.error("Failed to fetch summaries:", err);
    } finally {
      setLoading(false);
    }
  }

  async function fetchAgents() {
    if (!currentOrg?.id) return;
    try {
      const res = await fetch(`/api/agents?orgId=${currentOrg.id}`);
      const json = await res.json();
      if (json.ok) {
        setAgents(json.agents.map((a: any) => ({ id: a.id, name: a.agentName })));
      }
    } catch (err) {
      console.error("Failed to fetch agents:", err);
    }
  }

  async function generateSummary(agentId: string, agentName: string) {
    if (!currentOrg?.id) return;
    setGenerating(true);
    try {
      const res = await fetch("/api/summaries/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId: currentOrg.id,
          agentId,
          agentName,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        await fetchSummaries(); // Refresh list
      }
    } catch (err) {
      console.error("Failed to generate summary:", err);
    } finally {
      setGenerating(false);
    }
  }

  async function generateAllSummaries() {
    if (!currentOrg?.id || agents.length === 0) return;
    setGenerating(true);
    try {
      // Generate summaries for all agents in parallel
      await Promise.all(
        agents.map((agent) =>
          fetch("/api/summaries/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orgId: currentOrg.id,
              agentId: agent.id,
              agentName: agent.name,
            }),
          })
        )
      );
      await fetchSummaries(); // Refresh list
    } catch (err) {
      console.error("Failed to generate summaries:", err);
    } finally {
      setGenerating(false);
    }
  }

  const filteredSummaries = filterAgent
    ? summaries.filter((s) => s.agentId === filterAgent)
    : summaries;

  return (
    <div className="p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Daily Summaries</h1>
          <p className="text-gray-400 mt-2">
            Automated daily standups and activity reports for your agents
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={fetchSummaries}
            disabled={loading}
            className="flex items-center space-x-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 text-white rounded-lg transition"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            <span>Refresh</span>
          </button>

          <button
            onClick={generateAllSummaries}
            disabled={generating || agents.length === 0}
            className="flex items-center space-x-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg transition"
          >
            <Calendar className="w-4 h-4" />
            <span>{generating ? "Generating..." : "Generate All"}</span>
          </button>
        </div>
      </div>

      {/* Filter */}
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <div className="flex items-center space-x-4">
          <Filter className="w-5 h-5 text-gray-400" />
          <select
            value={filterAgent}
            onChange={(e) => setFilterAgent(e.target.value)}
            className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white"
          >
            <option value="">All Agents</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>

          {filterAgent && (
            <button
              onClick={() => setFilterAgent("")}
              className="text-sm text-blue-400 hover:text-blue-300"
            >
              Clear Filter
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
          <p className="text-sm text-gray-400">Total Summaries</p>
          <p className="text-3xl font-bold text-white mt-2">{summaries.length}</p>
        </div>

        <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
          <p className="text-sm text-gray-400">Agents Tracked</p>
          <p className="text-3xl font-bold text-white mt-2">
            {new Set(summaries.map((s) => s.agentId)).size}
          </p>
        </div>

        <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
          <p className="text-sm text-gray-400">Latest Summary</p>
          <p className="text-lg font-medium text-white mt-2">
            {summaries.length > 0 ? summaries[0].date : "—"}
          </p>
        </div>
      </div>

      {/* Summaries List */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-gray-400">Loading summaries...</div>
        </div>
      ) : filteredSummaries.length === 0 ? (
        <div className="bg-gray-800 rounded-lg p-12 border border-gray-700 text-center">
          <Calendar className="w-12 h-12 text-gray-600 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-white mb-2">No Summaries Yet</h3>
          <p className="text-gray-400 mb-4">
            {filterAgent
              ? "No summaries found for this agent"
              : "Generate your first daily summary to get started"}
          </p>
          {!filterAgent && agents.length > 0 && (
            <button
              onClick={generateAllSummaries}
              disabled={generating}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white rounded-lg transition"
            >
              {generating ? "Generating..." : "Generate Now"}
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredSummaries.map((summary) => (
            <SummaryCard
              key={summary.id}
              summary={summary}
              expanded={expandedId === summary.id}
              onExpand={() => setExpandedId(expandedId === summary.id ? null : summary.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
