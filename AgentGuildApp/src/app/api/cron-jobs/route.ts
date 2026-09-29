import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { requireInternalService } from '@/lib/auth-guard';

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || path.join(os.homedir(), '.openclaw');
const AGENT_ID = process.env.OPENCLAW_AGENT || 'main';
const memDir = path.join(OPENCLAW_DIR, 'agents', AGENT_ID, 'memory');

function getCronFile() {
    return path.join(memDir, 'CRON.json');
}

function verifyServiceAuth(req: NextRequest): boolean {
    const auth = requireInternalService(req);
    return auth.ok;
}

export async function GET(req: NextRequest) {
    // Auth: internal service or local dashboard (dev only)
    const isDev = process.env.NODE_ENV === 'development';
    const isLocal = isDev && (req.headers.get('host')?.startsWith('localhost') || req.headers.get('host')?.startsWith('127.0.0.1'));
    if (!isLocal && !verifyServiceAuth(req)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const cronFile = getCronFile();
        if (!fs.existsSync(cronFile)) {
            return NextResponse.json({ config: {} });
        }
        const data = fs.readFileSync(cronFile, 'utf8');
        return NextResponse.json({ config: JSON.parse(data) });
    } catch (error) {
        console.error('Error fetching cron jobs:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

const MAX_PROMPT_LENGTH = 10_000; // 10KB max prompt
const MAX_INBOX_ITEMS = 100;

export async function POST(req: NextRequest) {
    // Auth: internal service or local dashboard (dev only)
    const isDev = process.env.NODE_ENV === 'development';
    const isLocal = isDev && (req.headers.get('host')?.startsWith('localhost') || req.headers.get('host')?.startsWith('127.0.0.1'));
    if (!isLocal && !verifyServiceAuth(req)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const body = await req.json();
        const action = body.action; // 'toggle', 'trigger', 'update'
        const cronFile = getCronFile();

        // Safety
        if (!fs.existsSync(memDir)) {
            fs.mkdirSync(memDir, { recursive: true });
        }

        let config: any = {};
        if (fs.existsSync(cronFile)) {
            try {
                config = JSON.parse(fs.readFileSync(cronFile, 'utf8'));
            } catch (e) {
                config = {};
            }
        }

        if (action === 'toggle') {
            const { taskId, active } = body;
            if (taskId && config[taskId]) {
                config[taskId].active = active;
                fs.writeFileSync(cronFile, JSON.stringify(config, null, 2));
            }
            return NextResponse.json({ success: true, config });
        }

        if (action === 'trigger') {
            const { prompt, taskId } = body;
            if (!prompt || typeof prompt !== 'string') {
                return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
            }
            if (prompt.length > MAX_PROMPT_LENGTH) {
                return NextResponse.json({ error: `prompt exceeds max length (${MAX_PROMPT_LENGTH} chars)` }, { status: 400 });
            }
            if (taskId && (typeof taskId !== 'string' || taskId.length > 200)) {
                return NextResponse.json({ error: 'invalid taskId' }, { status: 400 });
            }

            // Write to the agent's INBOX.json — OpenClaw agents poll this file for pending actions
            const inboxFile = path.join(memDir, 'INBOX.json');
            let inbox: Array<Record<string, unknown>> = [];
            if (fs.existsSync(inboxFile)) {
                try {
                    inbox = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
                    if (!Array.isArray(inbox)) inbox = [];
                } catch {
                    inbox = [];
                }
            }

            // Prevent unbounded inbox growth
            if (inbox.length >= MAX_INBOX_ITEMS) {
                inbox = inbox.slice(-Math.floor(MAX_INBOX_ITEMS / 2));
            }

            inbox.push({
                id: `trigger_${Date.now()}`,
                type: 'cron_trigger',
                taskId: taskId || null,
                prompt,
                source: 'dashboard',
                createdAt: new Date().toISOString(),
                status: 'pending',
            });

            fs.writeFileSync(inboxFile, JSON.stringify(inbox, null, 2));

            // Also update lastRun on the cron task if taskId provided
            if (taskId && config[taskId]) {
                config[taskId].lastRun = Date.now();
                fs.writeFileSync(cronFile, JSON.stringify(config, null, 2));
            }

            return NextResponse.json({ success: true, message: 'Action queued in agent inbox' });
        }

        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });

    } catch (error) {
        console.error('Error modifying cron jobs:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
