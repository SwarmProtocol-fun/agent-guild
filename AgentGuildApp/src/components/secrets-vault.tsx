"use client";

import { useState } from "react";
import { Key, Eye, EyeOff, Plus, Trash2, Copy, Check } from "lucide-react";
import type { Secret } from "@/lib/secrets";

interface SecretsVaultProps {
  orgId: string;
  secrets: Secret[];
  masterSecret: string;
  onSecretsChange: () => void;
}

export function SecretsVault({
  orgId,
  secrets,
  masterSecret,
  onSecretsChange,
}: SecretsVaultProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newSecret, setNewSecret] = useState({ key: "", value: "", description: "" });
  const [saving, setSaving] = useState(false);
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const handleDelete = async (secretId: string) => {
    setDeleting(secretId);
    try {
      const res = await fetch(`/api/secrets/${secretId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId }),
      });

      const data = await res.json();
      if (data.ok) {
        // Clear revealed value if it was shown
        const updated = { ...revealedSecrets };
        delete updated[secretId];
        setRevealedSecrets(updated);
        onSecretsChange();
      } else {
        alert(data.error || "Failed to delete secret");
      }
    } catch (err) {
      console.error("Failed to delete secret:", err);
      alert("Failed to delete secret");
    } finally {
      setDeleting(null);
    }
  };

  const handleAddSecret = async () => {
    if (!newSecret.key || !newSecret.value) {
      alert("Key and value are required");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId,
          key: newSecret.key,
          value: newSecret.value,
          description: newSecret.description,
          createdBy: orgId,
          masterSecret,
        }),
      });

      const data = await res.json();
      if (data.ok) {
        setNewSecret({ key: "", value: "", description: "" });
        setShowAddForm(false);
        onSecretsChange();
      } else {
        alert(data.error || "Failed to store secret");
      }
    } catch (err) {
      console.error("Failed to add secret:", err);
      alert("Failed to add secret");
    } finally {
      setSaving(false);
    }
  };

  const handleReveal = async (secretId: string) => {
    if (revealedSecrets[secretId]) {
      // Hide
      const updated = { ...revealedSecrets };
      delete updated[secretId];
      setRevealedSecrets(updated);
      return;
    }

    try {
      const res = await fetch(`/api/secrets/${secretId}/reveal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, masterSecret }),
      });

      const data = await res.json();
      if (data.ok) {
        setRevealedSecrets({ ...revealedSecrets, [secretId]: data.value });
      } else {
        alert(data.error || "Failed to reveal secret");
      }
    } catch (err) {
      console.error("Failed to reveal secret:", err);
      alert("Failed to reveal secret");
    }
  };

  const handleCopy = async (secretId: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(secretId);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Key className="w-5 h-5 text-blue-400" />
          <h3 className="text-lg font-semibold text-white">Secrets Vault</h3>
          <span className="text-xs bg-gray-700 text-gray-300 px-2 py-1 rounded">
            {secrets.length} secret{secrets.length !== 1 ? "s" : ""}
          </span>
        </div>

        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm transition flex items-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Secret
        </button>
      </div>

      {/* Add Form */}
      {showAddForm && (
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Key
              </label>
              <input
                type="text"
                value={newSecret.key}
                onChange={(e) => setNewSecret({ ...newSecret, key: e.target.value })}
                placeholder="e.g., openai_api_key"
                className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Value
              </label>
              <input
                type="password"
                value={newSecret.value}
                onChange={(e) => setNewSecret({ ...newSecret, value: e.target.value })}
                placeholder="Secret value..."
                className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Description (optional)
              </label>
              <input
                type="text"
                value={newSecret.description}
                onChange={(e) => setNewSecret({ ...newSecret, description: e.target.value })}
                placeholder="What is this secret for?"
                className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setShowAddForm(false);
                  setNewSecret({ key: "", value: "", description: "" });
                }}
                disabled={saving}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white rounded text-sm transition"
              >
                Cancel
              </button>
              <button
                onClick={handleAddSecret}
                disabled={saving || !newSecret.key || !newSecret.value}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded text-sm transition"
              >
                {saving ? "Saving..." : "Save Secret"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Secrets List */}
      <div className="space-y-2">
        {secrets.map((secret) => {
          const isRevealed = !!revealedSecrets[secret.id];
          const displayValue = isRevealed ? revealedSecrets[secret.id] : secret.maskedPreview;

          return (
            <div
              key={secret.id}
              className="bg-gray-800 rounded-lg p-4 border border-gray-700 hover:bg-gray-750 transition"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h4 className="font-mono text-sm font-medium text-white">{secret.key}</h4>
                    {secret.description && (
                      <span className="text-xs text-gray-400">- {secret.description}</span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <code className="text-xs bg-gray-900 px-2 py-1 rounded text-gray-300 font-mono">
                      {displayValue}
                    </code>
                    {isRevealed && (
                      <button
                        onClick={() => handleCopy(secret.id, revealedSecrets[secret.id])}
                        className="p-1 hover:bg-gray-700 rounded transition text-gray-400 hover:text-white"
                        title="Copy to clipboard"
                      >
                        {copiedId === secret.id ? (
                          <Check className="w-3.5 h-3.5 text-green-400" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                    <span>Accessed {secret.accessCount} times</span>
                    {secret.lastAccessedAt && (
                      <span>Last: {new Date(secret.lastAccessedAt).toLocaleDateString()}</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleReveal(secret.id)}
                    className="p-2 hover:bg-gray-700 rounded transition text-gray-400 hover:text-white"
                    title={isRevealed ? "Hide" : "Reveal"}
                  >
                    {isRevealed ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete secret "${secret.key}"?`)) {
                        handleDelete(secret.id);
                      }
                    }}
                    disabled={deleting === secret.id}
                    className="p-2 hover:bg-gray-700 rounded transition text-gray-400 hover:text-red-400 disabled:opacity-50"
                    title="Delete"
                  >
                    <Trash2 className={`w-4 h-4 ${deleting === secret.id ? "animate-pulse" : ""}`} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        {secrets.length === 0 && !showAddForm && (
          <div className="text-center p-8 bg-gray-800 rounded-lg border border-gray-700">
            <Key className="w-12 h-12 mx-auto text-gray-600 mb-3" />
            <p className="text-gray-400">No secrets stored</p>
            <p className="text-xs text-gray-500 mt-1">
              Click &quot;Add Secret&quot; to store encrypted credentials
            </p>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="text-xs text-gray-400 bg-gray-800/50 rounded-lg p-3 border border-gray-700">
        <p className="font-medium mb-1">🔒 AES-256-GCM Encryption</p>
        <p>
          All secrets are encrypted using AES-256-GCM before storage. Values are only decrypted when
          revealed. Master secret never leaves your browser.
        </p>
      </div>
    </div>
  );
}
