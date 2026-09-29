"use client";

import { useState, useEffect } from "react";
import { Save, AlertCircle, CheckCircle, FileCode, RotateCcw } from "lucide-react";
import type { ValidationResult } from "@/lib/soul";

interface SOULEditorProps {
  agentId: string;
  orgId: string;
  initialContent?: string;
  isDefault?: boolean;
  onSave?: () => void;
}

export function SOULEditor({
  agentId,
  orgId,
  initialContent = "",
  isDefault = false,
  onSave,
}: SOULEditorProps) {
  const [content, setContent] = useState(initialContent);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    setContent(initialContent);
  }, [initialContent]);

  useEffect(() => {
    setHasChanges(content !== initialContent);
  }, [content, initialContent]);

  const handleValidate = async () => {
    setValidating(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/soul/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ soulConfig: content }),
      });

      const data = await res.json();
      if (data.ok && data.validation) {
        setValidation(data.validation);
      }
    } catch (err) {
      console.error("Validation error:", err);
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async () => {
    // Validate first
    await handleValidate();

    // Check if valid
    if (validation && !validation.valid) {
      alert("Cannot save: SOUL configuration has errors. Please fix them first.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/soul`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, soulConfig: content }),
      });

      const data = await res.json();
      if (data.ok) {
        setHasChanges(false);
        onSave?.();
        alert("SOUL configuration saved successfully!");
      } else {
        alert(data.error || "Failed to save SOUL configuration");
      }
    } catch (err) {
      console.error("Save error:", err);
      alert("Failed to save SOUL configuration");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (!hasChanges || confirm("Discard unsaved changes?")) {
      setContent(initialContent);
      setValidation(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileCode className="w-5 h-5 text-blue-400" />
          <h3 className="text-lg font-semibold text-white">SOUL Configuration</h3>
          {isDefault && (
            <span className="text-xs bg-gray-700 text-gray-300 px-2 py-1 rounded">
              Default Template
            </span>
          )}
          {hasChanges && (
            <span className="text-xs bg-orange-500/20 text-orange-400 px-2 py-1 rounded">
              Unsaved Changes
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleValidate}
            disabled={validating || !content}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed text-white rounded text-sm transition flex items-center gap-1.5"
          >
            {validating ? (
              <>Validating...</>
            ) : (
              <>
                <AlertCircle className="w-3.5 h-3.5" />
                Validate
              </>
            )}
          </button>
          <button
            onClick={handleReset}
            disabled={!hasChanges || saving}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed text-white rounded text-sm transition flex items-center gap-1.5"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !hasChanges || !content}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded text-sm transition flex items-center gap-1.5"
          >
            {saving ? (
              <>Saving...</>
            ) : (
              <>
                <Save className="w-3.5 h-3.5" />
                Save SOUL
              </>
            )}
          </button>
        </div>
      </div>

      {/* Validation Results */}
      {validation && (
        <div className="space-y-2">
          {validation.valid ? (
            <div className="flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
              <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
              <span className="text-sm text-green-300">
                Configuration is valid! {validation.warnings.length > 0 && `(${validation.warnings.length} warning${validation.warnings.length > 1 ? "s" : ""})`}
              </span>
            </div>
          ) : (
            <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <span className="text-sm font-medium text-red-300 block mb-1">
                  {validation.errors.length} error{validation.errors.length > 1 ? "s" : ""} found
                </span>
                <ul className="text-xs text-red-200 space-y-1">
                  {validation.errors.map((error, i) => (
                    <li key={i}>
                      <span className="font-mono text-red-400">{error.field}</span>: {error.message}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {validation.warnings.length > 0 && (
            <div className="flex items-start gap-2 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
              <AlertCircle className="w-4 h-4 text-yellow-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <span className="text-sm font-medium text-yellow-300 block mb-1">
                  {validation.warnings.length} warning{validation.warnings.length > 1 ? "s" : ""}
                </span>
                <ul className="text-xs text-yellow-200 space-y-1">
                  {validation.warnings.map((warning, i) => (
                    <li key={i}>
                      <span className="font-mono text-yellow-400">{warning.field}</span>: {warning.message}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Editor */}
      <div className="relative">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="w-full h-[600px] bg-gray-900 border border-gray-700 rounded-lg p-4 text-white font-mono text-sm focus:border-blue-500 focus:outline-none resize-none"
          placeholder="Enter SOUL configuration in YAML format..."
          spellCheck={false}
        />
        <div className="absolute bottom-3 right-3 text-xs text-gray-500">
          {content.split("\n").length} lines • {content.length} characters
        </div>
      </div>

      {/* Help Text */}
      <div className="text-xs text-gray-400 space-y-1">
        <p>
          <strong>SOUL</strong> (System Of Understanding & Learning) defines your agent&apos;s personality, behavior, and capabilities.
        </p>
        <p>
          Format: YAML • Version: 1.0 • Required sections: identity, personality, behavior, capabilities
        </p>
      </div>
    </div>
  );
}
