"use client";

import { useState, useEffect } from "react";
import { Folder, FileText, ChevronRight, Save, Loader2, ArrowLeft, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

interface FileNode {
    type: 'file' | 'directory';
    name: string;
    path: string;
    size: number;
    modified: number;
}

export function FileManager() {
    const [files, setFiles] = useState<FileNode[]>([]);
    const [loading, setLoading] = useState(true);
    const [currentPath, setCurrentPath] = useState("");
    const [selectedFile, setSelectedFile] = useState<FileNode | null>(null);
    const [fileContent, setFileContent] = useState("");
    const [saving, setSaving] = useState(false);

    const fetchFiles = async () => {
        try {
            setLoading(true);
            const res = await fetch("/api/workspace-files");
            if (res.ok) {
                const data = await res.json();
                setFiles(data.files || []);
            }
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchFiles(); }, []);

    const openFile = async (file: FileNode) => {
        if (file.type === 'directory') {
            setCurrentPath(file.path);
            return;
        }

        try {
            setSelectedFile(file);
            setFileContent("Loading...");
            const res = await fetch(`/api/workspace-files?path=${encodeURIComponent(file.path)}`);
            if (res.ok) {
                const data = await res.json();
                setFileContent(data.content);
            } else {
                setFileContent("Error loading file content.");
            }
        } catch (err) {
            setFileContent("Error loading file content.");
        }
    };

    const saveFile = async () => {
        if (!selectedFile) return;
        try {
            setSaving(true);
            await fetch("/api/workspace-files", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "save", path: selectedFile.path, content: fileContent })
            });
            // Refresh to update modified time
            fetchFiles();
        } catch (err) {
            console.error(err);
        } finally {
            setSaving(false);
        }
    };

    const visibleFiles = files
        .filter(f => {
            if (currentPath === "") return !f.path.includes("/");
            return f.path.startsWith(currentPath + "/") && f.path.substring(currentPath.length + 1).indexOf("/") === -1;
        })
        .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

    const goUp = () => {
        if (currentPath === "") return;
        const parts = currentPath.split("/");
        parts.pop();
        setCurrentPath(parts.join("/"));
    };

    if (selectedFile) {
        return (
            <Card className="flex flex-col h-[600px] border-border bg-card/50 overflow-hidden">
                <div className="flex items-center justify-between p-3 border-b border-border bg-muted/20">
                    <div className="flex items-center gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setSelectedFile(null)} className="h-8">
                            <ArrowLeft className="w-4 h-4 mr-1" /> Back
                        </Button>
                        <div className="flex items-center text-sm font-mono text-muted-foreground">
                            <FileText className="w-4 h-4 mr-2" />
                            {selectedFile.path}
                        </div>
                    </div>
                    <Button size="sm" onClick={saveFile} disabled={saving} className="h-8 bg-purple-600 hover:bg-purple-700 text-white">
                        {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                        Save Changes
                    </Button>
                </div>
                <textarea
                    value={fileContent}
                    onChange={(e) => setFileContent(e.target.value)}
                    className="flex-1 w-full p-4 bg-black/40 text-foreground font-mono text-sm resize-none focus:outline-none custom-scrollbar"
                    spellCheck={false}
                />
            </Card>
        );
    }

    return (
        <Card className="flex flex-col h-[600px] border-border bg-card/50 overflow-hidden">
            <div className="flex items-center justify-between p-3 border-b border-border bg-muted/20">
                <div className="flex items-center gap-2 text-sm text-foreground">
                    <button onClick={() => setCurrentPath("")} className="hover:text-purple-400 transition-colors">workspace</button>
                    {currentPath.split("/").filter(Boolean).map((part, i, arr) => (
                        <div key={i} className="flex items-center gap-2">
                            <ChevronRight className="w-3 h-3 text-muted-foreground" />
                            <button
                                onClick={() => setCurrentPath(arr.slice(0, i + 1).join("/"))}
                                className="hover:text-purple-400 transition-colors"
                            >
                                {part}
                            </button>
                        </div>
                    ))}
                </div>
                <div className="flex items-center gap-2">
                    {currentPath !== "" && (
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={goUp}>
                            <ArrowLeft className="w-4 h-4" />
                        </Button>
                    )}
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={fetchFiles} disabled={loading}>
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    </Button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
                {loading && files.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                    </div>
                ) : visibleFiles.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                        <Folder className="w-12 h-12 mb-2 opacity-20" />
                        <p className="text-sm">Folder is empty</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                        {visibleFiles.map((file) => (
                            <button
                                key={file.path}
                                onClick={() => openFile(file)}
                                className="flex items-start gap-3 p-3 rounded-lg border border-transparent hover:border-purple-500/20 hover:bg-white/5 transition-all text-left group"
                            >
                                {file.type === 'directory' ? (
                                    <Folder className="w-8 h-8 text-blue-400 shrink-0 mt-0.5" />
                                ) : (
                                    <FileText className="w-8 h-8 text-muted-foreground shrink-0 mt-0.5" />
                                )}
                                <div className="flex-1 min-w-0">
                                    <p className="font-medium text-sm truncate group-hover:text-purple-300 transition-colors">
                                        {file.name}
                                    </p>
                                    <p className="text-xs text-muted-foreground mt-1">
                                        {file.type === 'file' ? `${(file.size / 1024).toFixed(1)} KB` : 'Folder'}
                                        <span className="mx-1">•</span>
                                        {new Date(file.modified).toLocaleDateString()}
                                    </p>
                                </div>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </Card>
    );
}
