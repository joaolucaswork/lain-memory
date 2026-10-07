/**
 * PGS Engine — Partitioned Graph Synthesis for Lain.
 * Orchestrates: partition → route → sweep → synthesize.
 */

import type {
  PGSConfig, LLMProvider, EnrichedPartition, SweepResult, PGSResult,
} from './defaults.js';
import { PGS_DEFAULTS } from './defaults.js';
import { runLouvain } from './louvain.js';
import { enrichPartitions } from './partitioner.js';
import { routeQuery } from './router.js';
import { sweepPartitions, sweepPartition as sweepOne } from './sweeper.js';
import { synthesize as runSynthesis } from './synthesizer.js';
import { PGSSessionManager } from './session.js';

interface PGSEngineOptions {
  sweepProvider: LLMProvider;
  synthesisProvider: LLMProvider;
  sessionsDir: string;
  config?: Partial<PGSConfig>;
  onEvent?: (event: Record<string, unknown>) => void;
}

interface GraphInput {
  nodes: Array<{ id: string; concept: string; embedding?: number[] | null; tag?: string; weight?: number }>;
  edges: Array<{ source: string; target: string; weight?: number }>;
}

export class PGSEngine {
  private sweepProvider: LLMProvider;
  private synthesisProvider: LLMProvider;
  private config: PGSConfig;
  private globalOnEvent: ((event: Record<string, unknown>) => void) | null;
  private sessions: PGSSessionManager;
  private partitionCache = new Map<string, EnrichedPartition[]>();

  constructor(options: PGSEngineOptions) {
    this.sweepProvider = options.sweepProvider;
    this.synthesisProvider = options.synthesisProvider;
    this.config = { ...PGS_DEFAULTS, ...(options.config || {}) };
    this.globalOnEvent = options.onEvent || null;
    this.sessions = new PGSSessionManager(options.sessionsDir);
  }

  static computeGraphHash(graph: GraphInput): string {
    const nodeCount = graph.nodes.length;
    const edgeCount = graph.edges.length;
    let idSum = 0;
    for (const node of graph.nodes) {
      let h = 5381;
      const s = String(node.id);
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
      idSum = (idSum + Math.abs(h)) | 0;
    }
    return `${nodeCount}:${edgeCount}:${idSum}`;
  }

  async execute(
    query: string, graph: GraphInput,
    options: {
      mode?: 'full' | 'continue' | 'targeted'; sessionId?: string;
      fullSweep?: boolean; sweepFraction?: number;
      queryEmbedding?: number[] | null;
      onEvent?: (event: Record<string, unknown>) => void;
    } = {}
  ): Promise<PGSResult> {
    const {
      mode = 'full', sessionId = 'default', fullSweep = false,
      sweepFraction, queryEmbedding = null, onEvent,
    } = options;

    const config = { ...this.config };
    if (sweepFraction !== undefined) config.sweepFraction = sweepFraction;

    const startTime = Date.now();
    const emit = (event: Record<string, unknown>) => { onEvent?.(event); this.globalOnEvent?.(event); };

    const nodes = graph.nodes;
    const edges = graph.edges;

    emit({ type: 'partitioning', nodeCount: nodes.length, edgeCount: edges.length });

    // Phase 0: Partition (cached)
    const partitions = this.getOrCreatePartitions(graph, config);
    emit({ type: 'partitioned', partitionCount: partitions.length });

    // Phase 1: Route
    emit({ type: 'routing' });
    const allRoutedPartitions = routeQuery(query, queryEmbedding, partitions, config);

    // Session tracking
    const session = await this.sessions.load(sessionId);
    const searchedIds = new Set(session?.searchedPartitionIds || []);

    let partitionsToSweep: EnrichedPartition[];
    switch (mode) {
      case 'continue': {
        partitionsToSweep = partitions.filter(p => !searchedIds.has(p.id));
        if (partitionsToSweep.length === 0) partitionsToSweep = partitions;
        break;
      }
      case 'targeted': {
        const remaining = partitions.filter(p => !searchedIds.has(p.id));
        if (remaining.length === 0) partitionsToSweep = partitions;
        else {
          partitionsToSweep = routeQuery(query, queryEmbedding, remaining, config);
          if (partitionsToSweep.length === 0) partitionsToSweep = remaining;
        }
        break;
      }
      default: {
        if (fullSweep) partitionsToSweep = partitions;
        else {
          const fraction = config.sweepFraction;
          let limit: number;
          if (fraction && fraction > 0 && fraction <= 1) limit = Math.max(1, Math.ceil(allRoutedPartitions.length * fraction));
          else limit = config.maxSweepPartitions;
          partitionsToSweep = allRoutedPartitions.slice(0, limit);
        }
      }
    }

    emit({ type: 'routed', selectedCount: partitionsToSweep.length, totalCount: partitions.length });

    // Phase 2: Sweep
    emit({ type: 'sweeping', count: partitionsToSweep.length });

    const nodeMap = new Map<string, (typeof nodes)[0]>();
    for (const node of nodes) nodeMap.set(String(node.id), node);

    const sweepResults = await sweepPartitions(
      query, partitionsToSweep, nodeMap, edges, partitions, this.sweepProvider, config, emit
    );

    const successfulSweeps = sweepResults.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value!);

    // Persist session
    const newSearchedIds = new Set([...searchedIds, ...partitionsToSweep.map(p => p.id)]);
    await this.sessions.save(sessionId, {
      query, mode,
      searchedPartitionIds: [...newSearchedIds],
      totalPartitions: partitions.length,
      timestamp: new Date().toISOString(),
    });

    if (successfulSweeps.length === 0) {
      return {
        answer: 'All sweeps failed. No results available.',
        metadata: {
          mode: 'pgs', pgs: {
            totalNodes: nodes.length, totalEdges: edges.length,
            totalPartitions: partitions.length, sweptPartitions: partitionsToSweep.length,
            successfulSweeps: 0, elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
            sessionMode: mode, sessionId,
            searched: newSearchedIds.size, remaining: partitions.length - newSearchedIds.size,
          }, timestamp: new Date().toISOString(),
        },
      };
    }

    // Phase 3: Synthesize
    emit({ type: 'synthesizing' });
    const synthesisResult = await runSynthesis(query, successfulSweeps, this.synthesisProvider, {
      totalNodes: nodes.length, totalEdges: edges.length,
      totalPartitions: partitions.length, selectedPartitions: partitionsToSweep.length,
    }, config);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    emit({ type: 'complete', elapsedMs: Date.now() - startTime });

    return {
      answer: synthesisResult,
      metadata: {
        mode: 'pgs', pgs: {
          totalNodes: nodes.length, totalEdges: edges.length,
          totalPartitions: partitions.length, sweptPartitions: partitionsToSweep.length,
          successfulSweeps: successfulSweeps.length, elapsed: `${elapsed}s`,
          sessionMode: mode, sessionId,
          searched: newSearchedIds.size, remaining: partitions.length - newSearchedIds.size,
        }, timestamp: new Date().toISOString(),
      },
    };
  }

  partition(graph: GraphInput): EnrichedPartition[] {
    const communities = runLouvain(graph.nodes, graph.edges, {
      minCommunitySize: this.config.minCommunitySize,
      targetPartitionMax: this.config.targetPartitionMax,
    });
    return enrichPartitions(communities, graph.nodes, graph.edges);
  }

  async sweepPartition(
    query: string, partition: EnrichedPartition, graph: GraphInput, allPartitions: EnrichedPartition[]
  ): Promise<SweepResult> {
    const nodeMap = new Map<string, (typeof graph.nodes)[0]>();
    for (const node of graph.nodes) nodeMap.set(String(node.id), node);
    return sweepOne(query, partition, nodeMap, graph.edges, allPartitions, this.sweepProvider, this.config);
  }

  async synthesize(query: string, sweepResults: SweepResult[], context: {
    totalNodes: number; totalEdges: number; totalPartitions: number; selectedPartitions: number;
  }): Promise<string> {
    return runSynthesis(query, sweepResults, this.synthesisProvider, context, this.config);
  }

  private getOrCreatePartitions(graph: GraphInput, config: PGSConfig): EnrichedPartition[] {
    const hash = PGSEngine.computeGraphHash(graph);
    if (this.partitionCache.has(hash)) return this.partitionCache.get(hash)!;
    const communities = runLouvain(graph.nodes, graph.edges, {
      minCommunitySize: config.minCommunitySize, targetPartitionMax: config.targetPartitionMax,
    });
    const partitions = enrichPartitions(communities, graph.nodes, graph.edges);
    this.partitionCache.set(hash, partitions);
    return partitions;
  }
}

export { PGS_DEFAULTS } from './defaults.js';
export type { PGSConfig, LLMProvider, EnrichedPartition, SweepResult, PGSResult } from './defaults.js';
