import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || path.join(os.homedir(), '.openclaw');
const AGENT_ID = process.env.OPENCLAW_AGENT || 'main';
const sessDir = path.join(OPENCLAW_DIR, 'agents', AGENT_ID, 'sessions');

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
    // Require authenticated session (injected by middleware)
    const sessionAddress = req.headers.get('x-session-address');
    if (!sessionAddress) {
        return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    try {
        const url = new URL(req.url);
        const rawLimit = parseInt(url.searchParams.get('limit') || '50', 10);
        const rawSince = parseInt(url.searchParams.get('since') || '0', 10);
        const limit = isNaN(rawLimit) ? 50 : Math.max(1, Math.min(rawLimit, 500));
        const since = isNaN(rawSince) || rawSince < 0 ? 0 : rawSince;

        if (!fs.existsSync(sessDir)) {
            return NextResponse.json({ events: [] });
        }

        const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));

        // Check modification times to only parse recently active sessions
        const fileStats = files.map(f => {
            const fullPath = path.join(sessDir, f);
            return { path: fullPath, mtime: fs.statSync(fullPath).mtimeMs };
        });

        // Sort files by modified time descending, take the latest 5
        fileStats.sort((a, b) => b.mtime - a.mtime);
        const recentFiles = fileStats.slice(0, 5);

        const allEvents: any[] = [];

        for (const { path: p } of recentFiles) {
            try {
                const lines = fs.readFileSync(p, 'utf8').split('\n');
                // We only care about the latest events anyway, read strictly from the end
                const recentLines = lines.slice(Math.max(0, lines.length - 100));

                for (const line of recentLines) {
                    if (!line.trim()) continue;
                    try {
                        const data = JSON.parse(line);
                        const ts = data.timestamp ? new Date(data.timestamp).getTime() : 0;
                        if (ts > since) {
                            const sessionId = path.basename(p, '.jsonl');
                            allEvents.push({ ...data, sessionId, ts });
                        }
                    } catch { }
                }
            } catch { }
        }

        // Sort globally by timestamp descending
        allEvents.sort((a, b) => b.ts - a.ts);

        return NextResponse.json({
            events: allEvents.slice(0, limit)
        });
    } catch (error) {
        console.error('Error in /api/live-feed:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
