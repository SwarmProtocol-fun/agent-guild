"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { SOULEditor } from "@/components/soul-editor";
import { useOrg } from "@/contexts/OrgContext";
import { getDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { Agent } from "@/lib/firestore";

export default function AgentSOULPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const agentId = resolvedParams.id;
  const router = useRouter();
  const { currentOrg } = useOrg();

  const [agent, setAgent] = useState<Agent | null>(null);
  const [soulConfig, setSOULConfig] = useState<string>("");
  const [isDefault, setIsDefault] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentOrg?.id) return;

    const loadAgentAndSOUL = async () => {
      setLoading(true);
      try {
        // Load agent
        const agentDoc = await getDoc(doc(db, "agents", agentId));
        if (agentDoc.exists()) {
          const agentData = { id: agentDoc.id, ...agentDoc.data() } as Agent;
          setAgent(agentData);

          // Load SOUL
          const res = await fetch(`/api/agents/${agentId}/soul`);
          const data = await res.json();

          if (data.ok) {
            setSOULConfig(data.soulConfig);
            setIsDefault(data.isDefault || false);
          }
        }
      } catch (err) {
        console.error("Failed to load agent/SOUL:", err);
      } finally {
        setLoading(false);
      }
    };

    loadAgentAndSOUL();
  }, [agentId, currentOrg?.id]);

  const handleSave = async () => {
    // Reload SOUL after save
    try {
      const res = await fetch(`/api/agents/${agentId}/soul`);
      const data = await res.json();
      if (data.ok) {
        setSOULConfig(data.soulConfig);
        setIsDefault(false); // No longer default after saving
      }
    } catch (err) {
      console.error("Failed to reload SOUL:", err);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <p className="text-gray-400">Agent not found</p>
        <button
          onClick={() => router.push("/agents")}
          className="text-blue-400 hover:text-blue-300 transition"
        >
          Return to Agents
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-[1200px] mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-6">
        <button
          onClick={() => router.push(`/agents/${agentId}`)}
          className="flex items-center gap-2 text-gray-400 hover:text-white transition mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Agent
        </button>

        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">
            SOUL Configuration
          </h1>
          <p className="text-sm text-gray-400 mt-2">
            Define personality and behavior for <span className="font-medium text-white">{agent.name}</span>
          </p>
        </div>
      </div>

      {/* Editor */}
      {currentOrg && (
        <SOULEditor
          agentId={agentId}
          orgId={currentOrg.id}
          initialContent={soulConfig}
          isDefault={isDefault}
          onSave={handleSave}
        />
      )}
    </div>
  );
}
