import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { requireInternalService } from '@/lib/auth-guard';

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || path.join(os.homedir(), '.openclaw');
const AGENT_ID = process.env.OPENCLAW_AGENT || 'main'; // Target agent id
const workspaceDir = path.join(OPENCLAW_DIR, 'agents', AGENT_ID);

function getFileList(dir: string, baseDir: string = dir): any[] {
    let results: any[] = [];
    try {
        const list = fs.readdirSync(dir);

        for (const file of list) {
            // Skip hidden files/directories natively if preferred
            if (file.startsWith('.')) continue;

            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);
            const relativePath = path.relative(baseDir, filePath);

            if (stat && stat.isDirectory()) {
                results.push({
                    type: 'directory',
                    name: file,
                    path: relativePath,
                    size: 0,
                    modified: stat.mtimeMs
                });
                // Recursively get files inside directory
                results = results.concat(getFileList(filePath, baseDir));
            } else {
                results.push({
                    type: 'file',
                    name: file,
                    path: relativePath,
                    size: stat.size,
                    modified: stat.mtimeMs
                });
            }
        }
    } catch (error) {
        console.error('Error reading directory:', dir, error);
    }
    return results;
}

function verifyAccess(req: NextRequest): boolean {
    // Allow local dashboard access in dev only, require service auth for remote
    const isDev = process.env.NODE_ENV === 'development';
    if (isDev) {
        const host = req.headers.get('host') || '';
        if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) return true;
    }
    return requireInternalService(req).ok;
}

export async function GET(req: NextRequest) {
    if (!verifyAccess(req)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const url = new URL(req.url);
        const getPath = url.searchParams.get('path');

        // Ensure workspace exists
        if (!fs.existsSync(workspaceDir)) {
            fs.mkdirSync(workspaceDir, { recursive: true });
            return NextResponse.json({ files: [] });
        }

        if (getPath) {
            // Resolve to absolute path (handles ../ traversal) and strip null bytes
            const targetFile = path.resolve(workspaceDir, getPath.replace(/\0/g, ''));

            // Strict containment — must be within workspaceDir
            if (!targetFile.startsWith(workspaceDir + path.sep) && targetFile !== workspaceDir) {
                return NextResponse.json({ error: 'Invalid path' }, { status: 403 });
            }

            if (fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
                const content = fs.readFileSync(targetFile, 'utf8');
                return NextResponse.json({ path: getPath, content });
            }
            return NextResponse.json({ error: 'File not found' }, { status: 404 });
        }

        // Otherwise, list all files in the workspace
        const files = getFileList(workspaceDir);
        return NextResponse.json({ files });

    } catch (error) {
        console.error('Error fetching workspace files:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    if (!verifyAccess(req)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const body = await req.json();
        const action = body.action; // 'save', 'delete'
        const targetPath = body.path;

        if (!targetPath) return NextResponse.json({ error: 'Path is required' }, { status: 400 });

        // Resolve to absolute path (handles ../ traversal) and strip null bytes
        const absolutePath = path.resolve(workspaceDir, targetPath.replace(/\0/g, ''));

        // Strict containment — must be within workspaceDir
        if (!absolutePath.startsWith(workspaceDir + path.sep) && absolutePath !== workspaceDir) {
            return NextResponse.json({ error: 'Invalid path' }, { status: 403 });
        }

        if (action === 'save') {
            const content = body.content || '';
            const dir = path.dirname(absolutePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            fs.writeFileSync(absolutePath, content, 'utf8');
            return NextResponse.json({ success: true, path: targetPath });
        }

        if (action === 'delete') {
            if (fs.existsSync(absolutePath)) {
                if (fs.statSync(absolutePath).isDirectory()) {
                    fs.rmdirSync(absolutePath, { recursive: true });
                } else {
                    fs.unlinkSync(absolutePath);
                }
                return NextResponse.json({ success: true, path: targetPath });
            }
            return NextResponse.json({ error: 'File not found' }, { status: 404 });
        }

        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });

    } catch (error) {
        console.error('Error modifying workspace files:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
