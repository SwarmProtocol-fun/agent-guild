/**
 * Credit Score Gauge — Semi-circular SVG gauge displaying credit score 300-900
 * with tier-colored arc segments and current score indicator.
 */
"use client";

import { CREDIT_TIERS, getTierForScore, CREDIT_SCORE_MIN, CREDIT_SCORE_MAX } from "@/lib/credit-tiers";
import { Badge } from "@/components/ui/badge";

interface CreditScoreGaugeProps {
    score: number;
    className?: string;
}

export function CreditScoreGauge({ score, className }: CreditScoreGaugeProps) {
    const tier = getTierForScore(score);
    const range = CREDIT_SCORE_MAX - CREDIT_SCORE_MIN; // 600
    const normalized = (score - CREDIT_SCORE_MIN) / range; // 0-1

    // SVG arc parameters
    const cx = 120;
    const cy = 110;
    const r = 90;
    const startAngle = Math.PI; // 180 degrees (left)
    const endAngle = 0; // 0 degrees (right)

    // Helper: angle for a given score value
    const scoreToAngle = (s: number) => {
        const t = (s - CREDIT_SCORE_MIN) / range;
        return startAngle - t * Math.PI;
    };

    // Create tier arc segments
    const tierArcs = CREDIT_TIERS.slice().reverse().map((t, i, arr) => {
        const from = t.minCredit;
        const to = i < arr.length - 1 ? arr[i + 1].minCredit : CREDIT_SCORE_MAX;
        const a1 = scoreToAngle(from);
        const a2 = scoreToAngle(to);
        const x1 = cx + r * Math.cos(a1);
        const y1 = cy - r * Math.sin(a1);
        const x2 = cx + r * Math.cos(a2);
        const y2 = cy - r * Math.sin(a2);
        const largeArc = a1 - a2 > Math.PI ? 1 : 0;

        return (
            <path
                key={t.name}
                d={`M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`}
                fill="none"
                stroke={t.chartColor}
                strokeWidth={12}
                strokeLinecap="round"
                opacity={0.3}
            />
        );
    });

    // Active arc from start to current score
    const activeAngle = scoreToAngle(score);
    const activeX = cx + r * Math.cos(activeAngle);
    const activeY = cy - r * Math.sin(activeAngle);
    const activeLargeArc = (startAngle - activeAngle) > Math.PI ? 1 : 0;

    // Needle/dot position
    const dotX = cx + (r + 2) * Math.cos(activeAngle);
    const dotY = cy - (r + 2) * Math.sin(activeAngle);

    return (
        <div className={className}>
            <svg viewBox="0 0 240 140" className="w-full max-w-[280px] mx-auto">
                {/* Background track */}
                <path
                    d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={12}
                    strokeLinecap="round"
                    className="text-muted/20"
                />

                {/* Tier segment arcs */}
                {tierArcs}

                {/* Active filled arc */}
                <path
                    d={`M ${cx - r} ${cy} A ${r} ${r} 0 ${activeLargeArc} 1 ${activeX} ${activeY}`}
                    fill="none"
                    stroke={tier.chartColor}
                    strokeWidth={12}
                    strokeLinecap="round"
                />

                {/* Indicator dot */}
                <circle cx={dotX} cy={dotY} r={6} fill={tier.chartColor} />
                <circle cx={dotX} cy={dotY} r={3} fill="white" />

                {/* Score text */}
                <text
                    x={cx}
                    y={cy - 12}
                    textAnchor="middle"
                    className="fill-foreground text-3xl font-bold"
                    fontSize={36}
                    fontWeight={700}
                >
                    {score}
                </text>

                {/* Range labels */}
                <text
                    x={cx - r - 2}
                    y={cy + 18}
                    textAnchor="middle"
                    className="fill-muted-foreground"
                    fontSize={10}
                >
                    {CREDIT_SCORE_MIN}
                </text>
                <text
                    x={cx + r + 2}
                    y={cy + 18}
                    textAnchor="middle"
                    className="fill-muted-foreground"
                    fontSize={10}
                >
                    {CREDIT_SCORE_MAX}
                </text>
            </svg>

            <div className="flex justify-center -mt-2">
                <Badge className={tier.badgeClass}>
                    {tier.name}
                </Badge>
            </div>
        </div>
    );
}
