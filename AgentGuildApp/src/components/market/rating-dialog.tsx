"use client";

import { useState } from "react";
import { Star, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

interface RatingDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    itemName: string;
    onSubmit: (rating: number, review: string) => Promise<void>;
}

export function RatingDialog({ open, onOpenChange, itemName, onSubmit }: RatingDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>Rate {itemName}</DialogTitle>
                </DialogHeader>
                <RatingInput onSubmit={onSubmit} />
            </DialogContent>
        </Dialog>
    );
}

function RatingInput({ onSubmit }: { onSubmit: (rating: number, review: string) => Promise<void> }) {
    const [rating, setRating] = useState(0);
    const [hover, setHover] = useState(0);
    const [review, setReview] = useState("");
    const [submitting, setSubmitting] = useState(false);

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-1 justify-center">
                {Array.from({ length: 5 }, (_, i) => (
                    <button
                        key={i}
                        onMouseEnter={() => setHover(i + 1)}
                        onMouseLeave={() => setHover(0)}
                        onClick={() => setRating(i + 1)}
                        className="p-1 transition-transform hover:scale-110"
                    >
                        <Star
                            className={`h-6 w-6 ${
                                (hover || rating) > i
                                    ? "text-amber-400 fill-amber-400"
                                    : "text-muted-foreground/30"
                            }`}
                        />
                    </button>
                ))}
            </div>
            <p className="text-center text-xs text-muted-foreground">
                {rating === 0 ? "Select a rating" : `${rating} star${rating > 1 ? "s" : ""}`}
            </p>
            <textarea
                placeholder="Write a review (optional, max 500 chars)"
                value={review}
                onChange={(e) => setReview(e.target.value.slice(0, 500))}
                className="w-full h-20 rounded-lg border border-border bg-muted/30 p-3 text-sm resize-none"
            />
            <Button
                onClick={async () => {
                    if (rating === 0) return;
                    setSubmitting(true);
                    await onSubmit(rating, review);
                    setSubmitting(false);
                }}
                disabled={rating === 0 || submitting}
                className="w-full bg-amber-600 hover:bg-amber-700 text-black gap-2"
            >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Star className="h-4 w-4" />}
                Submit Rating
            </Button>
        </div>
    );
}
