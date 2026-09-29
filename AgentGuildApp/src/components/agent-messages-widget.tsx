'use client';

/**
 * Agent Messages Widget
 *
 * Displays structured agent-to-agent messages (a2a, coord, session)
 * Real-time updates via Firestore onSnapshot
 */

import { useEffect, useState } from 'react';
import { collection, query, where, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { A2AMessage, CoordMessage, SessionMessage } from '@/lib/agent-messaging';

interface AgentMessagesWidgetProps {
  agentId: string;
  orgId: string;
}

export default function AgentMessagesWidget({ agentId, orgId }: AgentMessagesWidgetProps) {
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'a2a' | 'coord' | 'session'>('all');

  useEffect(() => {
    const q = query(
      collection(db, 'agentMessages'),
      where('orgId', '==', orgId),
      where('to', '==', agentId),
      orderBy('timestamp', 'desc'),
      limit(50)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgs = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
      setMessages(msgs);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [agentId, orgId]);

  const filteredMessages =
    filter === 'all' ? messages : messages.filter((m) => m.type === filter);

  const unreadCount = messages.filter((m) => m.deliveryStatus !== 'read').length;

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <div className="animate-pulse">
          <div className="h-4 bg-gray-300 dark:bg-gray-700 rounded w-1/3 mb-4"></div>
          <div className="space-y-3">
            <div className="h-10 bg-gray-200 dark:bg-gray-700 rounded"></div>
            <div className="h-10 bg-gray-200 dark:bg-gray-700 rounded"></div>
            <div className="h-10 bg-gray-200 dark:bg-gray-700 rounded"></div>
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
              Agent Messages
            </h3>
            {unreadCount > 0 && (
              <span className="px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 rounded-full">
                {unreadCount} new
              </span>
            )}
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => setFilter('all')}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${
              filter === 'all'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            All ({messages.length})
          </button>
          <button
            onClick={() => setFilter('a2a')}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${
              filter === 'a2a'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            A2A ({messages.filter((m) => m.type === 'a2a').length})
          </button>
          <button
            onClick={() => setFilter('coord')}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${
              filter === 'coord'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            Coord ({messages.filter((m) => m.type === 'coord').length})
          </button>
          <button
            onClick={() => setFilter('session')}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${
              filter === 'session'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            Session ({messages.filter((m) => m.type === 'session').length})
          </button>
        </div>
      </div>

      <div className="divide-y divide-gray-200 dark:divide-gray-700 max-h-96 overflow-y-auto">
        {filteredMessages.length === 0 ? (
          <div className="p-6 text-center text-gray-500 dark:text-gray-400">
            No {filter === 'all' ? '' : filter} messages
          </div>
        ) : (
          filteredMessages.map((msg) => (
            <MessageItem key={msg.id} message={msg} />
          ))
        )}
      </div>
    </div>
  );
}

function MessageItem({ message }: { message: any }) {
  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'a2a':
        return '💬';
      case 'coord':
        return '🎯';
      case 'session':
        return '🔄';
      case 'broadcast':
        return '📢';
      default:
        return '✉️';
    }
  };

  const getTypeBadge = (type: string) => {
    const badges: Record<string, { bg: string; text: string }> = {
      a2a: { bg: 'bg-blue-100 dark:bg-blue-900', text: 'text-blue-800 dark:text-blue-200' },
      coord: {
        bg: 'bg-purple-100 dark:bg-purple-900',
        text: 'text-purple-800 dark:text-purple-200',
      },
      session: {
        bg: 'bg-green-100 dark:bg-green-900',
        text: 'text-green-800 dark:text-green-200',
      },
      broadcast: {
        bg: 'bg-orange-100 dark:bg-orange-900',
        text: 'text-orange-800 dark:text-orange-200',
      },
    };
    const badge = badges[type] || { bg: 'bg-gray-100', text: 'text-gray-800' };
    return (
      <span
        className={`px-2 py-0.5 text-xs font-medium rounded ${badge.bg} ${badge.text}`}
      >
        {type.toUpperCase()}
      </span>
    );
  };

  const isUnread = message.deliveryStatus !== 'read';

  return (
    <div
      className={`p-4 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${
        isUnread ? 'bg-blue-50 dark:bg-blue-900/20' : ''
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="text-2xl">{getTypeIcon(message.type)}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {getTypeBadge(message.type)}
            <span className="text-sm font-medium text-gray-900 dark:text-white">
              {message.fromName || message.from}
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {new Date(message.timestamp).toLocaleString()}
            </span>
            {isUnread && (
              <span className="w-2 h-2 bg-blue-600 rounded-full" title="Unread"></span>
            )}
          </div>

          {message.type === 'a2a' && (
            <div className="text-sm text-gray-700 dark:text-gray-300">
              {typeof message.payload === 'string'
                ? message.payload
                : JSON.stringify(message.payload, null, 2)}
            </div>
          )}

          {message.type === 'coord' && (
            <div className="text-sm">
              <span className="font-medium text-gray-900 dark:text-white">
                Action: {message.action}
              </span>
              <div className="text-gray-700 dark:text-gray-300 mt-1">
                {typeof message.payload === 'string'
                  ? message.payload
                  : JSON.stringify(message.payload, null, 2)}
              </div>
            </div>
          )}

          {message.type === 'session' && (
            <div className="text-sm">
              <span className="font-medium text-gray-900 dark:text-white">
                Session: {message.sessionId}
              </span>
              <div className="text-gray-700 dark:text-gray-300 mt-1">
                {typeof message.payload === 'string'
                  ? message.payload
                  : JSON.stringify(message.payload, null, 2)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
