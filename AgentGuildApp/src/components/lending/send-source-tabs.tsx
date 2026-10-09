/** "Agent's wallet" / "My own wallet" switch for lending sends. */
"use client";

export type SendSource = "agent" | "self";

export function SendSourceTabs({ value, onChange, label }: { value: SendSource; onChange: (v: SendSource) => void; label: string }) {
    return (
        <div className="grid grid-cols-2 gap-1 rounded-md bg-[hsl(var(--muted))] p-0.5" role="tablist" aria-label={label}>
            {([["agent", "Agent's wallet"], ["self", "My own wallet"]] as const).map(([id, text]) => (
                <button
                    key={id} type="button" role="tab" aria-selected={value === id}
                    onClick={() => onChange(id)}
                    className={`rounded px-2 py-1 text-xs font-medium transition-colors ${value === id ? "bg-[hsl(var(--background))] shadow-sm" : "text-muted-foreground hover:text-[hsl(var(--foreground))]"}`}
                >
                    {text}
                </button>
            ))}
        </div>
    );
}
