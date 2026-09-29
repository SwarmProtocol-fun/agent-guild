'use client';

/**
 * Coordinator Dashboard Widget
 *
 * Displays registered coordinators, their load, and status
 * Shows coordinator capabilities and availability
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

interface CoordinatorDashboardWidgetProps {
  orgId: string;
  projectId?: string;
  channelId?: string;
}

export default function CoordinatorDashboardWidget({
  orgId,
  projectId,
  channelId,
}: CoordinatorDashboardWidgetProps) {
  const [coordinators, setCoordinators] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'available' | 'busy'>('all');

  useEffect(() => {
    let q = query(
      collection(db, 'coordinators'),
      where('orgId', '==', orgId),
      where('active', '==', true),
      orderBy('registeredAt', 'desc'),
      limit(50)
    );

    // Apply optional filters
    if (projectId) {
      q = query(
        collection(db, 'coordinators'),
        where('orgId', '==', orgId),
        where('projectId', '==', projectId),
        where('active', '==', true),
        orderBy('registeredAt', 'desc'),
        limit(50)
      );
    } else if (channelId) {
      q = query(
        collection(db, 'coordinators'),
        where('orgId', '==', orgId),
        where('channelId', '==', channelId),
        where('active', '==', true),
        orderBy('registeredAt', 'desc'),
        limit(50)
      );
    }

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const coords = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
          registeredAt: doc.data().registeredAt?.toMillis(),
        }));
        setCoordinators(coords);
        setLoading(false);
        setError(null);
      },
      (err) => {
        console.error('[CoordinatorWidget] Firestore error:', err);
        setLoading(false);
        if (err.message?.includes('index')) {
          setError('Database index required. This widget is temporarily unavailable.');
        } else {
          setError('Failed to load coordinators');
        }
      }
    );

    return () => unsubscribe();
  }, [orgId, projectId, channelId]);

  const filteredCoordinators = coordinators.filter((c) => {
    if (filter === 'all') return true;
    const load = c.currentLoad || 0;
    const capacity = c.maxConcurrentTasks || 10;
    if (filter === 'available') return load < capacity;
    if (filter === 'busy') return load >= capacity;
    return true;
  });

  const availableCount = coordinators.filter(
    (c) => (c.currentLoad || 0) < (c.maxConcurrentTasks || 10)
  ).length;

  if (error) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <div className="text-center py-4">
          <div className="text-3xl mb-2">⚠️</div>
          <p className="text-sm text-muted-foreground mb-2">{error}</p>
          <p className="text-xs text-muted-foreground/60">
            Remove this widget or contact your administrator
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <div className="animate-pulse">
          <div className="h-4 bg-gray-300 dark:bg-gray-700 rounded w-1/3 mb-4"></div>
          <div className="space-y-3">
            <div className="h-24 bg-gray-200 dark:bg-gray-700 rounded"></div>
            <div className="h-24 bg-gray-200 dark:bg-gray-700 rounded"></div>
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
              Coordinators
            </h3>
            {availableCount > 0 && (
              <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 rounded-full">
                {availableCount} available
              </span>
            )}
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => setFilter('all')}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${
              filter === 'all'
                ? 'bg-purple-600 text-white'
                : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            All ({coordinators.length})
          </button>
          <button
            onClick={() => setFilter('available')}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${
              filter === 'available'
                ? 'bg-purple-600 text-white'
                : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            Available ({availableCount})
          </button>
          <button
            onClick={() => setFilter('busy')}
            className={`px-3 py-1 text-sm rounded-md transition-colors ${
              filter === 'busy'
                ? 'bg-purple-600 text-white'
                : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            Busy ({coordinators.length - availableCount})
          </button>
        </div>
      </div>

      <div className="divide-y divide-gray-200 dark:divide-gray-700 max-h-96 overflow-y-auto">
        {filteredCoordinators.length === 0 ? (
          <div className="p-6 text-center text-gray-500 dark:text-gray-400">
            No {filter === 'all' ? '' : filter} coordinators
          </div>
        ) : (
          filteredCoordinators.map((coordinator) => (
            <CoordinatorItem key={coordinator.id} coordinator={coordinator} />
          ))
        )}
      </div>
    </div>
  );
}

function CoordinatorItem({ coordinator }: { coordinator: any }) {
  const load = coordinator.currentLoad || 0;
  const capacity = coordinator.maxConcurrentTasks || 10;
  const isAvailable = load < capacity;
  const loadPercentage = (load / capacity) * 100;

  const getLoadColor = (percentage: number) => {
    if (percentage >= 100) return 'bg-red-500';
    if (percentage >= 75) return 'bg-orange-500';
    if (percentage >= 50) return 'bg-yellow-500';
    return 'bg-green-500';
  };

  return (
    <div className="p-4 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <div
              className={`w-2 h-2 rounded-full ${
                isAvailable ? 'bg-green-500' : 'bg-red-500'
              }`}
              title={isAvailable ? 'Available' : 'At capacity'}
            ></div>
            <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
              {coordinator.agentName}
            </span>
            {!isAvailable && (
              <span className="px-2 py-0.5 text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 rounded">
                BUSY
              </span>
            )}
          </div>

          <div className="space-y-2">
            <div className="text-xs text-gray-600 dark:text-gray-400">
              <span className="font-medium">ID:</span> {coordinator.agentId}
            </div>

            {coordinator.responsibilities && coordinator.responsibilities.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {coordinator.responsibilities.map((resp: string, idx: number) => (
                  <span
                    key={idx}
                    className="px-2 py-0.5 text-xs bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 rounded"
                  >
                    {resp}
                  </span>
                ))}
              </div>
            )}

            <div>
              <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400 mb-1">
                <span className="font-medium">Load</span>
                <span>
                  {load}/{capacity} ({Math.round(loadPercentage)}%)
                </span>
              </div>
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                <div
                  className={`h-2 rounded-full transition-all ${getLoadColor(loadPercentage)}`}
                  style={{ width: `${Math.min(100, loadPercentage)}%` }}
                ></div>
              </div>
            </div>

            <div className="text-xs text-gray-500 dark:text-gray-400">
              Registered {new Date(coordinator.registeredAt).toLocaleString()}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          {coordinator.projectId && (
            <span className="px-2 py-0.5 text-xs bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 rounded">
              Project
            </span>
          )}
          {coordinator.channelId && (
            <span className="px-2 py-0.5 text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 rounded">
              Channel
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
