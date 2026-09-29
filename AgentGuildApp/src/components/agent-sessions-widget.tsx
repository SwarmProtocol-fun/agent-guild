'use client';

/**
 * Agent Sessions Widget
 *
 * Displays active agent workflow sessions
 * Allows session management (view, close)
 */

import { useEffect, useState } from 'react';
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  doc,
  updateDoc,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';

interface AgentSessionsWidgetProps {
  agentId: string;
  orgId: string;
}

export default function AgentSessionsWidget({ agentId, orgId }: AgentSessionsWidgetProps) {
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'active' | 'completed' | 'all'>('active');

  useEffect(() => {
    const q = query(
      collection(db, 'agentSessions'),
      where('orgId', '==', orgId),
      where('participants', 'array-contains', agentId),
      orderBy('createdAt', 'desc'),
      limit(50)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const sess = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
        createdAt: doc.data().createdAt?.toMillis(),
        expiresAt: doc.data().expiresAt?.toMillis(),
        closedAt: doc.data().closedAt?.toMillis(),
      }));
      setSessions(sess);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [agentId, orgId]);

  const filteredSessions =
    statusFilter === 'all'
      ? sessions
      : sessions.filter((s) => s.status === statusFilter);

  const activeSessions = sessions.filter((s) => s.status === 'active');

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <div className="animate-pulse">
          <div className="h-4 bg-gray-300 dark:bg-gray-700 rounded w-1/3 mb-4"></div>
          <div className="space-y-3">
            <div className="h-20 bg-gray-200 dark:bg-gray-700 rounded"></div>
            <div className="h-20 bg-gray-200 dark:bg-gray-700 rounded"></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Workflow Sessions
            </h3>
            {activeSessions.length > 0 && (
              <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 rounded-full">
                {activeSessions.length} active
              </span>
            )}
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => setStatusFilter('active')}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${
              statusFilter === 'active'
                ? 'bg-green-600 text-white'
                : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            Active ({activeSessions.length})
          </button>
          <button
            onClick={() => setStatusFilter('completed')}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${
              statusFilter === 'completed'
                ? 'bg-green-600 text-white'
                : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            Completed ({sessions.filter((s) => s.status === 'completed').length})
          </button>
          <button
            onClick={() => setStatusFilter('all')}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${
              statusFilter === 'all'
                ? 'bg-green-600 text-white'
                : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            All ({sessions.length})
          </button>
        </div>
      </div>

      <div className="divide-y divide-gray-200 dark:divide-gray-700 max-h-96 overflow-y-auto">
        {filteredSessions.length === 0 ? (
          <div className="p-6 text-center text-gray-500 dark:text-gray-400">
            No {statusFilter === 'all' ? '' : statusFilter} sessions
          </div>
        ) : (
          filteredSessions.map((session) => (
            <SessionItem key={session.id} session={session} agentId={agentId} />
          ))
        )}
      </div>
    </div>
  );
}

function SessionItem({ session, agentId }: { session: any; agentId: string }) {
  const [closing, setClosing] = useState(false);

  const handleClose = async (status: 'completed' | 'cancelled') => {
    if (!confirm(`Are you sure you want to mark this session as ${status}?`)) return;

    setClosing(true);
    try {
      await updateDoc(doc(db, 'agentSessions', session.id), {
        status,
        closedAt: new Date(),
        closedBy: agentId,
      });
    } catch (err) {
      console.error('Failed to close session:', err);
      alert('Failed to close session. Please try again.');
    } finally {
      setClosing(false);
    }
  };

  const isExpired = session.expiresAt && session.expiresAt < Date.now();
  const timeRemaining = session.expiresAt
    ? Math.max(0, session.expiresAt - Date.now())
    : null;

  const formatTimeRemaining = (ms: number) => {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  };

  const getStatusBadge = (status: string) => {
    const badges: Record<string, { bg: string; text: string }> = {
      active: { bg: 'bg-green-100 dark:bg-green-900', text: 'text-green-800 dark:text-green-200' },
      completed: {
        bg: 'bg-blue-100 dark:bg-blue-900',
        text: 'text-blue-800 dark:text-blue-200',
      },
      cancelled: { bg: 'bg-gray-100 dark:bg-gray-700', text: 'text-gray-800 dark:text-gray-300' },
      expired: { bg: 'bg-red-100 dark:bg-red-900', text: 'text-red-800 dark:text-red-200' },
    };
    const badge = badges[status] || { bg: 'bg-gray-100', text: 'text-gray-800' };
    return (
      <span className={`px-2 py-0.5 text-xs font-medium rounded ${badge.bg} ${badge.text}`}>
        {status.toUpperCase()}
      </span>
    );
  };

  return (
    <div className="p-4 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            {getStatusBadge(isExpired ? 'expired' : session.status)}
            <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
              {session.purpose}
            </span>
          </div>

          <div className="space-y-1 text-xs text-gray-600 dark:text-gray-400">
            <div>
              <span className="font-medium">ID:</span> {session.id}
            </div>
            <div>
              <span className="font-medium">Coordinator:</span> {session.coordinatorId}
            </div>
            <div>
              <span className="font-medium">Participants:</span>{' '}
              {session.participants?.join(', ') || 'None'}
            </div>
            <div>
              <span className="font-medium">Messages:</span> {session.messageCount || 0}
            </div>
            <div>
              <span className="font-medium">Created:</span>{' '}
              {new Date(session.createdAt).toLocaleString()}
            </div>
            {timeRemaining !== null && (
              <div>
                <span className="font-medium">
                  {isExpired ? 'Expired' : 'Expires in'}:
                </span>{' '}
                {isExpired ? (
                  <span className="text-red-600 dark:text-red-400">
                    {new Date(session.expiresAt).toLocaleString()}
                  </span>
                ) : (
                  <span className="text-green-600 dark:text-green-400">
                    {formatTimeRemaining(timeRemaining)}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {session.status === 'active' && (
          <div className="flex gap-2">
            <button
              onClick={() => handleClose('completed')}
              disabled={closing}
              className="px-3 py-1 text-xs font-medium bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Complete
            </button>
            <button
              onClick={() => handleClose('cancelled')}
              disabled={closing}
              className="px-3 py-1 text-xs font-medium bg-gray-600 text-white rounded hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
