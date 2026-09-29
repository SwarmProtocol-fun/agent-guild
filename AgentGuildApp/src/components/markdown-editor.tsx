"use client";

import { useState } from "react";
import { Eye, Edit, Save, X } from "lucide-react";

interface MarkdownEditorProps {
  initialContent: string;
  onSave: (content: string) => Promise<void>;
  title?: string;
  readOnly?: boolean;
}

export function MarkdownEditor({
  initialContent,
  onSave,
  title,
  readOnly = false,
}: MarkdownEditorProps) {
  const [content, setContent] = useState(initialContent);
  const [mode, setMode] = useState<"edit" | "preview">("preview");
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const handleContentChange = (newContent: string) => {
    setContent(newContent);
    setHasChanges(newContent !== initialContent);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(content);
      setHasChanges(false);
    } catch (err) {
      console.error("Failed to save:", err);
      alert("Failed to save content");
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setContent(initialContent);
    setHasChanges(false);
    setMode("preview");
  };

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-700">
        <div>
          {title && <h3 className="text-lg font-bold text-white">{title}</h3>}
        </div>
        <div className="flex items-center space-x-2">
          {!readOnly && (
            <>
              <button
                onClick={() => setMode(mode === "edit" ? "preview" : "edit")}
                className={`flex items-center space-x-2 px-3 py-1.5 rounded transition ${
                  mode === "edit"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                }`}
              >
                {mode === "edit" ? (
                  <>
                    <Eye className="w-4 h-4" />
                    <span>Preview</span>
                  </>
                ) : (
                  <>
                    <Edit className="w-4 h-4" />
                    <span>Edit</span>
                  </>
                )}
              </button>

              {hasChanges && (
                <>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="flex items-center space-x-2 px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 text-white rounded transition"
                  >
                    <Save className="w-4 h-4" />
                    <span>{saving ? "Saving..." : "Save"}</span>
                  </button>
                  <button
                    onClick={handleCancel}
                    disabled={saving}
                    className="flex items-center space-x-2 px-3 py-1.5 bg-red-600/20 hover:bg-red-600/30 border border-red-500/30 text-red-400 rounded transition"
                  >
                    <X className="w-4 h-4" />
                    <span>Cancel</span>
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="p-4">
        {mode === "edit" ? (
          <textarea
            value={content}
            onChange={(e) => handleContentChange(e.target.value)}
            className="w-full h-[500px] bg-gray-900 text-gray-100 font-mono text-sm p-4 rounded border border-gray-600 focus:border-blue-500 focus:outline-none resize-none"
            placeholder="Write markdown here..."
            spellCheck={false}
          />
        ) : (
          <div
            className="prose prose-invert max-w-none text-gray-100"
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(content),
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Escape HTML entities to prevent XSS before markdown processing */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Simple markdown renderer (basic support)
function renderMarkdown(markdown: string): string {
  // Escape HTML first to prevent XSS via dangerouslySetInnerHTML
  let html = escapeHtml(markdown);

  // Headers
  html = html.replace(/^#### (.*$)/gim, '<h4 class="text-lg font-semibold mt-4 mb-2">$1</h4>');
  html = html.replace(/^### (.*$)/gim, '<h3 class="text-xl font-semibold mt-4 mb-2">$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2 class="text-2xl font-bold mt-6 mb-3">$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1 class="text-3xl font-bold mt-6 mb-4">$1</h1>');

  // Bold
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold">$1</strong>');
  html = html.replace(/__(.*?)__/g, '<strong class="font-bold">$1</strong>');

  // Italic
  html = html.replace(/\*(.*?)\*/g, '<em class="italic">$1</em>');
  html = html.replace(/_(.*?)_/g, '<em class="italic">$1</em>');

  // Code blocks
  html = html.replace(/```([\s\S]*?)```/g, '<pre class="bg-gray-900 p-4 rounded my-2 overflow-x-auto"><code>$1</code></pre>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="bg-gray-700 px-1.5 py-0.5 rounded text-sm">$1</code>');

  // Links — only allow safe protocols (no javascript:, data:, vbscript:)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, href: string) => {
    const trimmed = href.trim().toLowerCase();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("mailto:") || trimmed.startsWith("/") || trimmed.startsWith("#")) {
      return `<a href="${href}" class="text-blue-400 hover:underline" target="_blank" rel="noopener">${text}</a>`;
    }
    return text; // Strip unsafe links, keep text
  });

  // Unordered lists
  html = html.replace(/^\s*[-*]\s+(.*)$/gim, '<li class="ml-4">$1</li>');
  html = html.replace(/(<li[\s\S]*<\/li>)/, '<ul class="list-disc my-2">$1</ul>');

  // Checkboxes
  html = html.replace(/- \[ \]/g, '<input type="checkbox" disabled class="mr-2">');
  html = html.replace(/- \[x\]/gi, '<input type="checkbox" checked disabled class="mr-2">');

  // Horizontal rule
  html = html.replace(/^---$/gim, '<hr class="border-gray-700 my-4">');

  // Line breaks
  html = html.replace(/\n/g, '<br>');

  return html;
}
