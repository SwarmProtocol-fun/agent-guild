/** Kanban Boards — Multi-board task management with agent assignments. */
"use client";

import { useState, useEffect, useCallback, useRef, type DragEvent } from "react";
import {
    Plus, GripVertical, Loader2, LayoutGrid, Trash2, ChevronDown, ChevronUp,
    CheckSquare, Square, Calendar, X, Users, Bot, Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useOrg } from "@/contexts/OrgContext";
import { useAuthAddress } from "@/hooks/useAuthAddress";
import { getAgentsByOrg, type Agent } from "@/lib/firestore";
import {
    type KanbanTask, type KanbanBoard, type KanbanStatus, type SubTask,
    KANBAN_COLUMNS, PRIORITY_CONFIG,
    createKanbanTask, updateKanbanTask, moveTask, deleteKanbanTask,
    getKanbanTasks, groupByStatus,
    createBoard, updateBoard, deleteBoard, getBoards,
} from "@/lib/kanban";

// ═══════════════════════════════════════════════════════════════
// Task Card
// ═══════════════════════════════════════════════════════════════

function TaskCard({
    task, onDelete, onUpdate,
}: {
    task: KanbanTask;
    onDelete: (id: string) => void;
    onUpdate: (id: string, updates: Partial<KanbanTask>) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const priority = PRIORITY_CONFIG[task.priority];
    const completedSubs = task.subtasks.filter(s => s.completed).length;
    const totalSubs = task.subtasks.length;

    const toggleSubtask = (subId: string) => {
        const updated = task.subtasks.map(s =>
            s.id === subId ? { ...s, completed: !s.completed } : s
        );
        onUpdate(task.id, { subtasks: updated });
    };

    return (
        <div
            draggable
            onDragStart={(e) => {
                e.dataTransfer.setData("taskId", task.id);
                e.dataTransfer.setData("fromStatus", task.status);
                e.dataTransfer.effectAllowed = "move";
            }}
            className="group cursor-grab active:cursor-grabbing"
        >
            <Card className="bg-card/80 border-border hover:border-amber-500/20 transition-all">
                <div className="p-3">
                    <div className="flex items-start gap-2">
                        <GripVertical className="h-3.5 w-3.5 text-muted-foreground/30 mt-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 mb-1">
                                {task.priority !== "none" && (
                                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${priority.dot}`} />
                                )}
                                <h4 className="text-sm font-medium leading-tight truncate">{task.title}</h4>
                            </div>

                            {task.description && (
                                <p className="text-[11px] text-muted-foreground line-clamp-2 mb-1.5">{task.description}</p>
                            )}

                            <div className="flex items-center gap-2 flex-wrap">
                                {task.assigneeName && (
                                    <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                                        {task.assigneeName}
                                    </Badge>
                                )}
                                {task.dueDate && (
                                    <span className="text-[9px] text-muted-foreground flex items-center gap-0.5">
                                        <Calendar className="h-2.5 w-2.5" />
                                        {task.dueDate}
                                    </span>
                                )}
                                {totalSubs > 0 && (
                                    <span className={`text-[9px] flex items-center gap-0.5 ${completedSubs === totalSubs ? "text-emerald-400" : "text-muted-foreground"
                                        }`}>
                                        <CheckSquare className="h-2.5 w-2.5" />
                                        {completedSubs}/{totalSubs}
                                    </span>
                                )}
                            </div>
                        </div>

                        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                            {totalSubs > 0 && (
                                <button onClick={() => setExpanded(!expanded)} className="p-0.5 rounded text-muted-foreground hover:text-foreground">
                                    {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                                </button>
                            )}
                            <button onClick={() => onDelete(task.id)} className="p-0.5 rounded text-muted-foreground hover:text-red-400">
                                <Trash2 className="h-3 w-3" />
                            </button>
                        </div>
                    </div>

                    {/* Subtask progress bar */}
                    {totalSubs > 0 && (
                        <div className="mt-2 h-1 bg-muted/30 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-emerald-500 rounded-full transition-all"
                                style={{ width: `${(completedSubs / totalSubs) * 100}%` }}
                            />
                        </div>
                    )}

                    {/* Expanded subtasks */}
                    {expanded && totalSubs > 0 && (
                        <div className="mt-2 pt-2 border-t border-border space-y-1">
                            {task.subtasks.map((sub) => (
                                <button
                                    key={sub.id}
                                    onClick={() => toggleSubtask(sub.id)}
                                    className="flex items-center gap-1.5 w-full text-left py-0.5 hover:bg-muted/20 rounded px-1 -mx-1"
                                >
                                    {sub.completed
                                        ? <CheckSquare className="h-3 w-3 text-emerald-400 shrink-0" />
                                        : <Square className="h-3 w-3 text-muted-foreground shrink-0" />
                                    }
                                    <span className={`text-[11px] ${sub.completed ? "line-through text-muted-foreground" : ""}`}>
                                        {sub.title}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </Card>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════
// Column
// ═══════════════════════════════════════════════════════════════

function KanbanColumn({
    column, tasks, onDrop, onAddTask, onDeleteTask, onUpdateTask,
}: {
    column: typeof KANBAN_COLUMNS[0];
    tasks: KanbanTask[];
    onDrop: (taskId: string, newStatus: KanbanStatus) => void;
    onAddTask: (status: KanbanStatus, title: string) => void;
    onDeleteTask: (id: string) => void;
    onUpdateTask: (id: string, updates: Partial<KanbanTask>) => void;
}) {
    const [dragOver, setDragOver] = useState(false);
    const [adding, setAdding] = useState(false);
    const [newTitle, setNewTitle] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    const handleDragOver = (e: DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver(true);
    };

    const handleDrop = (e: DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        const taskId = e.dataTransfer.getData("taskId");
        if (taskId) onDrop(taskId, column.key);
    };

    const handleAdd = () => {
        if (newTitle.trim()) {
            onAddTask(column.key, newTitle.trim());
            setNewTitle("");
            setAdding(false);
        }
    };

    useEffect(() => {
        if (adding && inputRef.current) inputRef.current.focus();
    }, [adding]);

    return (
        <div
            onDragOver={handleDragOver}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={`flex flex-col min-w-[240px] max-w-[280px] flex-1 rounded-xl border-t-2 transition-colors ${column.color} ${dragOver ? "bg-amber-500/5" : "bg-transparent"
                }`}
        >
            {/* Column header */}
            <div className="px-3 py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                    <span className="text-sm">{column.icon}</span>
                    <span className="text-xs font-semibold">{column.label}</span>
                    <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 min-w-[18px] justify-center">
                        {tasks.length}
                    </Badge>
                </div>
                <button
                    onClick={() => setAdding(true)}
                    className="p-0.5 rounded text-muted-foreground hover:text-amber-400 transition-colors"
                >
                    <Plus className="h-3.5 w-3.5" />
                </button>
            </div>

            {/* Inline add */}
            {adding && (
                <div className="mx-2 mb-2">
                    <div className="flex gap-1">
                        <Input
                            ref={inputRef}
                            value={newTitle}
                            onChange={(e) => setNewTitle(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") handleAdd();
                                if (e.key === "Escape") { setAdding(false); setNewTitle(""); }
                            }}
                            placeholder="Task title..."
                            className="text-xs h-7"
                        />
                        <button onClick={() => { setAdding(false); setNewTitle(""); }} className="p-1 text-muted-foreground">
                            <X className="h-3 w-3" />
                        </button>
                    </div>
                </div>
            )}

            {/* Task cards */}
            <div className="flex-1 px-2 pb-2 space-y-1.5 overflow-y-auto max-h-[60vh]">
                {tasks.map((task) => (
                    <TaskCard key={task.id} task={task} onDelete={onDeleteTask} onUpdate={onUpdateTask} />
                ))}
                {tasks.length === 0 && !adding && (
                    <div className="py-8 text-center">
                        <p className="text-[10px] text-muted-foreground/50">Drop tasks here</p>
                    </div>
                )}
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════
// Board Tab
// ═══════════════════════════════════════════════════════════════

function BoardTab({
    board, isActive, onClick, onDelete,
}: {
    board: KanbanBoard;
    isActive: boolean;
    onClick: () => void;
    onDelete: (id: string) => void;
}) {
    return (
        <button
            onClick={onClick}
            className={`group relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
                isActive
                    ? "bg-amber-500/10 text-amber-500 border border-amber-500/30"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50 border border-transparent"
            }`}
        >
            <LayoutGrid className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate max-w-[120px]">{board.name}</span>
            {board.agentIds.length > 0 && (
                <Badge variant="outline" className="text-[8px] px-1 py-0 h-3.5 shrink-0">
                    <Bot className="h-2 w-2 mr-0.5" />
                    {board.agentIds.length}
                </Badge>
            )}
            <button
                onClick={(e) => { e.stopPropagation(); onDelete(board.id); }}
                className="p-0.5 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-400 transition-all shrink-0"
                title="Delete board"
            >
                <X className="h-3 w-3" />
            </button>
        </button>
    );
}

// ═══════════════════════════════════════════════════════════════
// Main Page
// ═══════════════════════════════════════════════════════════════

export default function KanbanPage() {
    const { currentOrg } = useOrg();
    const authAddress = useAuthAddress();

    // Boards
    const [boards, setBoards] = useState<KanbanBoard[]>([]);
    const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
    const [loadingBoards, setLoadingBoards] = useState(true);

    // Tasks for active board
    const [tasks, setTasks] = useState<KanbanTask[]>([]);
    const [loadingTasks, setLoadingTasks] = useState(false);

    // Agents for assignment
    const [agents, setAgents] = useState<Agent[]>([]);

    // Dialogs
    const [showCreateBoard, setShowCreateBoard] = useState(false);
    const [showBoardSettings, setShowBoardSettings] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

    // Create board form
    const [newBoardName, setNewBoardName] = useState("");
    const [newBoardDesc, setNewBoardDesc] = useState("");
    const [newBoardAgents, setNewBoardAgents] = useState<string[]>([]);

    // Edit board form (for settings dialog)
    const [editBoardName, setEditBoardName] = useState("");
    const [editBoardDesc, setEditBoardDesc] = useState("");
    const [editBoardAgents, setEditBoardAgents] = useState<string[]>([]);

    const activeBoard = boards.find(b => b.id === activeBoardId) || null;

    // ── Load boards ──

    const loadBoards = useCallback(async () => {
        if (!currentOrg) return;
        try {
            setLoadingBoards(true);
            const data = await getBoards(currentOrg.id);
            setBoards(data);
            // Select first board if none selected or current no longer exists
            if (data.length > 0 && (!activeBoardId || !data.find(b => b.id === activeBoardId))) {
                setActiveBoardId(data[0].id);
            }
            if (data.length === 0) {
                setActiveBoardId(null);
            }
        } catch (err) {
            console.error("Failed to load boards:", err);
        } finally {
            setLoadingBoards(false);
        }
    }, [currentOrg, activeBoardId]);

    // ── Load tasks for active board ──

    const loadTasks = useCallback(async () => {
        if (!currentOrg || !activeBoardId) { setTasks([]); return; }
        try {
            setLoadingTasks(true);
            const data = await getKanbanTasks(currentOrg.id, activeBoardId);
            setTasks(data);
        } catch (err) {
            console.error("Failed to load kanban tasks:", err);
        } finally {
            setLoadingTasks(false);
        }
    }, [currentOrg, activeBoardId]);

    // ── Load agents ──

    const loadAgents = useCallback(async () => {
        if (!currentOrg) return;
        try {
            const data = await getAgentsByOrg(currentOrg.id);
            setAgents(data);
        } catch (err) {
            console.error("Failed to load agents:", err);
        }
    }, [currentOrg]);

    useEffect(() => { loadBoards(); loadAgents(); }, [loadBoards, loadAgents]);
    useEffect(() => { loadTasks(); }, [loadTasks]);

    const grouped = groupByStatus(tasks);

    // ── Board CRUD ──

    const handleCreateBoard = async () => {
        if (!currentOrg || !newBoardName.trim()) return;
        try {
            const id = await createBoard({
                orgId: currentOrg.id,
                name: newBoardName.trim(),
                description: newBoardDesc.trim() || undefined,
                agentIds: newBoardAgents,
            });
            setShowCreateBoard(false);
            setNewBoardName("");
            setNewBoardDesc("");
            setNewBoardAgents([]);
            await loadBoards();
            setActiveBoardId(id);
        } catch (err) {
            console.error("Failed to create board:", err);
        }
    };

    const handleDeleteBoard = async (id: string) => {
        try {
            await deleteBoard(id);
            setConfirmDeleteId(null);
            if (activeBoardId === id) setActiveBoardId(null);
            await loadBoards();
        } catch (err) {
            console.error("Failed to delete board:", err);
        }
    };

    const handleUpdateBoard = async () => {
        if (!activeBoard || !editBoardName.trim()) return;
        try {
            await updateBoard(activeBoard.id, {
                name: editBoardName.trim(),
                description: editBoardDesc.trim() || undefined,
                agentIds: editBoardAgents,
            });
            setShowBoardSettings(false);
            await loadBoards();
        } catch (err) {
            console.error("Failed to update board:", err);
        }
    };

    const openBoardSettings = () => {
        if (!activeBoard) return;
        setEditBoardName(activeBoard.name);
        setEditBoardDesc(activeBoard.description || "");
        setEditBoardAgents([...activeBoard.agentIds]);
        setShowBoardSettings(true);
    };

    // ── Task CRUD ──

    const handleDrop = async (taskId: string, newStatus: KanbanStatus) => {
        setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus } : t));
        try {
            const col = grouped[newStatus];
            const newPos = col.length + 1;
            await moveTask(taskId, newStatus, newPos);
        } catch {
            loadTasks();
        }
    };

    const handleAddTask = async (status: KanbanStatus, title: string) => {
        if (!currentOrg || !activeBoardId) return;
        try {
            await createKanbanTask({ orgId: currentOrg.id, boardId: activeBoardId, title, status });
            await loadTasks();
        } catch (err) {
            console.error("Failed to create task:", err);
        }
    };

    const handleDeleteTask = async (id: string) => {
        setTasks(prev => prev.filter(t => t.id !== id));
        try { await deleteKanbanTask(id); } catch { loadTasks(); }
    };

    const handleUpdateTask = async (id: string, updates: Partial<KanbanTask>) => {
        setTasks(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
        try { await updateKanbanTask(id, updates); } catch { loadTasks(); }
    };

    // ── Agent toggle helper ──

    const toggleAgent = (agentId: string, list: string[], setList: (ids: string[]) => void) => {
        if (list.includes(agentId)) {
            setList(list.filter(id => id !== agentId));
        } else {
            setList([...list, agentId]);
        }
    };

    // ── Guards ──

    if (!authAddress) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-muted-foreground">
                <LayoutGrid className="h-12 w-12 opacity-30" />
                <p>Connect your wallet to use boards</p>
            </div>
        );
    }

    // ── Agent picker component ──

    const AgentPicker = ({ selected, onToggle }: { selected: string[]; onToggle: (id: string) => void }) => (
        <div className="space-y-1 max-h-[200px] overflow-y-auto">
            {agents.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">No agents registered in this org</p>
            ) : (
                agents.map(agent => {
                    const isSelected = selected.includes(agent.id);
                    return (
                        <button
                            key={agent.id}
                            type="button"
                            onClick={() => onToggle(agent.id)}
                            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
                                isSelected ? "bg-amber-500/10 border border-amber-500/30" : "hover:bg-muted/50 border border-transparent"
                            }`}
                        >
                            <div className={`w-2 h-2 rounded-full shrink-0 ${
                                agent.status === "online" ? "bg-emerald-500" :
                                agent.status === "busy" ? "bg-amber-500" : "bg-muted-foreground/40"
                            }`} />
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate">{agent.name}</p>
                                <p className="text-[10px] text-muted-foreground">{agent.type}</p>
                            </div>
                            {isSelected && (
                                <CheckSquare className="h-4 w-4 text-amber-500 shrink-0" />
                            )}
                        </button>
                    );
                })
            )}
        </div>
    );

    // ── Assigned agents for active board ──

    const assignedAgents = activeBoard
        ? agents.filter(a => activeBoard.agentIds.includes(a.id))
        : [];

    return (
        <div className="max-w-[1400px] mx-auto px-4 py-8">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
                        <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20">
                            <LayoutGrid className="h-6 w-6 text-amber-500" />
                        </div>
                        Boards
                    </h1>
                    <p className="text-sm text-muted-foreground mt-2">
                        Kanban-style task management — create boards, assign agents, drag cards
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {activeBoard && (
                        <Badge variant="outline" className="text-xs">
                            {tasks.length} tasks
                        </Badge>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setShowCreateBoard(true)} className="gap-1.5">
                        <Plus className="h-3.5 w-3.5" />
                        New Board
                    </Button>
                </div>
            </div>

            {/* Loading */}
            {loadingBoards ? (
                <div className="flex items-center justify-center py-20">
                    <Loader2 className="h-6 w-6 animate-spin text-amber-500" />
                </div>
            ) : boards.length === 0 ? (
                /* Empty state — no boards */
                <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                    <LayoutGrid className="h-16 w-16 opacity-20 mb-4" />
                    <p className="text-lg font-medium mb-1">No boards yet</p>
                    <p className="text-sm mb-4">Create your first board to start organizing tasks</p>
                    <Button onClick={() => setShowCreateBoard(true)} className="bg-amber-600 hover:bg-amber-700 text-white gap-1.5">
                        <Plus className="h-4 w-4" />
                        Create Board
                    </Button>
                </div>
            ) : (
                <>
                    {/* Board tabs + settings */}
                    <div className="flex items-center gap-2 mb-6 overflow-x-auto pb-1">
                        <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-x-auto">
                            {boards.map(board => (
                                <BoardTab
                                    key={board.id}
                                    board={board}
                                    isActive={board.id === activeBoardId}
                                    onClick={() => setActiveBoardId(board.id)}
                                    onDelete={(id) => setConfirmDeleteId(id)}
                                />
                            ))}
                        </div>
                        {activeBoard && (
                            <div className="flex items-center gap-1.5 shrink-0 border-l border-border pl-3 ml-1">
                                {/* Assigned agent avatars */}
                                {assignedAgents.length > 0 && (
                                    <div className="flex items-center -space-x-1 mr-1">
                                        {assignedAgents.slice(0, 4).map(agent => (
                                            <div
                                                key={agent.id}
                                                title={agent.name}
                                                className="w-6 h-6 rounded-full bg-muted border-2 border-background flex items-center justify-center text-[9px] font-bold"
                                            >
                                                {agent.name.charAt(0).toUpperCase()}
                                            </div>
                                        ))}
                                        {assignedAgents.length > 4 && (
                                            <div className="w-6 h-6 rounded-full bg-muted border-2 border-background flex items-center justify-center text-[9px] font-medium text-muted-foreground">
                                                +{assignedAgents.length - 4}
                                            </div>
                                        )}
                                    </div>
                                )}
                                <Button size="sm" variant="ghost" onClick={openBoardSettings} className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground">
                                    <Settings2 className="h-3.5 w-3.5" />
                                </Button>
                            </div>
                        )}
                    </div>

                    {/* Kanban columns */}
                    {loadingTasks ? (
                        <div className="flex items-center justify-center py-20">
                            <Loader2 className="h-6 w-6 animate-spin text-amber-500" />
                        </div>
                    ) : activeBoardId ? (
                        <div className="flex gap-3 overflow-x-auto pb-4">
                            {KANBAN_COLUMNS.map((col) => (
                                <KanbanColumn
                                    key={col.key}
                                    column={col}
                                    tasks={grouped[col.key]}
                                    onDrop={handleDrop}
                                    onAddTask={handleAddTask}
                                    onDeleteTask={handleDeleteTask}
                                    onUpdateTask={handleUpdateTask}
                                />
                            ))}
                        </div>
                    ) : null}
                </>
            )}

            {/* ═══ Create Board Dialog ═══ */}
            <Dialog open={showCreateBoard} onOpenChange={setShowCreateBoard}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Create Board</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 pt-2">
                        <div className="space-y-2">
                            <Label>Board Name</Label>
                            <Input
                                value={newBoardName}
                                onChange={e => setNewBoardName(e.target.value)}
                                placeholder="e.g. Sprint 12, Research Tasks..."
                                onKeyDown={e => { if (e.key === "Enter" && newBoardName.trim()) handleCreateBoard(); }}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Description <span className="text-muted-foreground text-xs">(optional)</span></Label>
                            <Textarea
                                value={newBoardDesc}
                                onChange={e => setNewBoardDesc(e.target.value)}
                                placeholder="What is this board for?"
                                rows={2}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="flex items-center gap-1.5">
                                <Users className="h-3.5 w-3.5" />
                                Assign Agents
                                {newBoardAgents.length > 0 && (
                                    <Badge variant="outline" className="text-[9px] px-1 py-0 ml-1">
                                        {newBoardAgents.length} selected
                                    </Badge>
                                )}
                            </Label>
                            <AgentPicker
                                selected={newBoardAgents}
                                onToggle={(id) => toggleAgent(id, newBoardAgents, setNewBoardAgents)}
                            />
                        </div>
                        <div className="flex justify-end gap-2 pt-2">
                            <Button variant="ghost" onClick={() => setShowCreateBoard(false)}>Cancel</Button>
                            <Button
                                onClick={handleCreateBoard}
                                disabled={!newBoardName.trim()}
                                className="bg-amber-600 hover:bg-amber-700 text-white"
                            >
                                Create Board
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* ═══ Board Settings Dialog ═══ */}
            <Dialog open={showBoardSettings} onOpenChange={setShowBoardSettings}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Board Settings</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 pt-2">
                        <div className="space-y-2">
                            <Label>Board Name</Label>
                            <Input
                                value={editBoardName}
                                onChange={e => setEditBoardName(e.target.value)}
                                placeholder="Board name..."
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Description <span className="text-muted-foreground text-xs">(optional)</span></Label>
                            <Textarea
                                value={editBoardDesc}
                                onChange={e => setEditBoardDesc(e.target.value)}
                                placeholder="What is this board for?"
                                rows={2}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="flex items-center gap-1.5">
                                <Users className="h-3.5 w-3.5" />
                                Assigned Agents
                                {editBoardAgents.length > 0 && (
                                    <Badge variant="outline" className="text-[9px] px-1 py-0 ml-1">
                                        {editBoardAgents.length} selected
                                    </Badge>
                                )}
                            </Label>
                            <AgentPicker
                                selected={editBoardAgents}
                                onToggle={(id) => toggleAgent(id, editBoardAgents, setEditBoardAgents)}
                            />
                        </div>
                        <div className="flex justify-end gap-2 pt-2">
                            <Button variant="ghost" onClick={() => setShowBoardSettings(false)}>Cancel</Button>
                            <Button
                                onClick={handleUpdateBoard}
                                disabled={!editBoardName.trim()}
                                className="bg-amber-600 hover:bg-amber-700 text-white"
                            >
                                Save Changes
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* ═══ Delete Confirmation Dialog ═══ */}
            <Dialog open={!!confirmDeleteId} onOpenChange={() => setConfirmDeleteId(null)}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Delete Board</DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-muted-foreground">
                        This will permanently delete the board and all its tasks. This action cannot be undone.
                    </p>
                    <div className="flex justify-end gap-2 pt-4">
                        <Button variant="ghost" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
                        <Button
                            variant="destructive"
                            onClick={() => confirmDeleteId && handleDeleteBoard(confirmDeleteId)}
                        >
                            Delete Board
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
