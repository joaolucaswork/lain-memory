#!/usr/bin/env bun

/**
 * lain-memory MCP Server (stdio).
 *
 * Exposes ONLY the memory surface (12 tools: 6 memory + 2 graph + 2 PGS +
 * 2 seeds). Calls the in-process backends directly — no HTTP round-trip to
 * :3341, no auth header, no session side-effects.
 *
 * Dropped on purpose (stays in lain/server while it lives there):
 * - activeProject hook (listProjects/sessionStore)
 * - [FLUSH:id] token hook (sessionStore)
 * Both are lain channel-layer concerns, not memory persistence.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  addMemoryWithConflictCheck,
  searchMemory,
  getMemories,
  deleteMemory,
  updateMemory,
  scanAndCleanProjectMemories,
  startMemoryMaintenance,
} from './mem0.js';
import {
  initGraph,
  query as graphQuery,
  cachedGetStats,
  cachedGetGraphForPGS,
} from './graphrag.js';
import { extractSeed, listSeeds } from './seed-extraction.js';
import { PGSEngine } from './pgs/index.js';
import { createPGSProviders } from './pgs/haiku-provider.js';
import { PGS_SESSIONS_DIR } from './workspace.js';
import { startDedupSweep } from './dedup-sweep.js';
import { startMemoryReaper } from './memory-reaper.js';

const TOOL_DEFINITIONS = [
  {
    name: 'remember',
    description:
      'Save a memory/fact to persistent storage. Use this to remember preferences, decisions, project context, or anything worth preserving across sessions. Memories are automatically deduplicated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'The fact or memory to save. Be specific and concise.' },
        project: { type: 'string', description: 'Project name (e.g. "lain", "kapso"). Omit for global memories.' },
        mode: {
          type: 'string',
          enum: ['atomic', 'bundle', 'index', 'raw'],
          description:
            'Save mode. atomic (default): normal dedup. bundle: treats input as a summary — tells conflict detector to prefer UPDATE over NOOP for overlapping atoms. index: skips conflict check entirely, for summaries of already-saved atoms. raw: stores text as-is without Mem0 decomposition (infer:false).',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'recall',
    description:
      'Search memories semantically. Returns the most relevant memories matching your query. Use this to retrieve context before starting work, check past decisions, or find user preferences.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What to search for. Natural language query.' },
        project: { type: 'string', description: 'Project name to search within. Omit to search global memories.' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'forget',
    description: 'Delete a specific memory by ID. Use when a memory is outdated or incorrect.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        memory_id: { type: 'string', description: 'The memory ID to delete' },
      },
      required: ['memory_id'],
    },
  },
  {
    name: 'update_memory',
    description:
      "Update an existing memory by ID. Avoids the forget+remember dance. No conflict check is run — the caller is asserting they want THIS memory replaced. NOTE: if Mem0 SDK doesn't support native update, this internally calls delete+add and the returned memory may have a NEW ID. Callers MUST NOT cache the input ID expecting it to persist.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'The memory ID to update' },
        memory: { type: 'string', description: 'New text content for this memory' },
        project: { type: 'string', description: 'Project name (optional, used for cache invalidation)' },
      },
      required: ['id', 'memory'],
    },
  },
  {
    name: 'list_memories',
    description: 'List all stored memories, optionally filtered by project. Use to review what has been remembered.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Project name to filter. Omit for global memories.' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'scan_memories',
    description:
      'Scan and clean stale project memories. Removes project-scoped memories older than 90 days with low quality score. Safe — never removes global memories. Returns a report of what was deleted.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Project name to scan (e.g. "lain", "reino-capital-pay")' },
      },
      required: ['project'],
    },
  },
  {
    name: 'graph_query',
    description:
      'Query the knowledge graph for entity relationships. Use for questions about connections between people, projects, technologies.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural language query' },
        depth: { type: 'number', description: 'Traversal depth (default: 2)' },
        maxNodes: { type: 'number', description: 'Max entities in context (default: 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'graph_stats',
    description: 'Get statistics about the knowledge graph: entity counts, relationship counts, types.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'pgs_query',
    description:
      'Run Partitioned Graph Synthesis on the knowledge graph. Partitions the graph into communities, sweeps each with LLM analysis, and synthesizes cross-domain insights. Use for deep analysis, gap detection, and novelty finding.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What to search for. Natural language query.' },
        mode: { type: 'string', description: 'Query mode: full (default), continue (sweep unsearched partitions), targeted (route to remaining)' },
        sessionId: { type: 'string', description: 'Session ID for coverage tracking (default: "default")' },
      },
      required: ['query'],
    },
  },
  {
    name: 'pgs_stats',
    description:
      'Get PGS partition statistics: how the knowledge graph is divided into communities, with keywords and summaries.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'seed_extract',
    description: 'Extract structured knowledge from a URL, PDF, or document. Saves extracted facts to memory and knowledge graph.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', description: 'URL or file path to process' },
        type: { type: 'string', description: 'Source type: url, pdf, docx, txt, text (auto-detected if omitted)' },
        rawText: { type: 'string', description: 'Raw text content (for type=text)' },
        project: { type: 'string', description: 'Project scope for memories (optional)' },
      },
      required: ['source'],
    },
  },
  {
    name: 'list_seeds',
    description: 'List all processed seed documents and their extraction summaries.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Filter by project (optional)' },
      },
    },
  },
];

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const err = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true });

async function handleTool(name: string, args: Record<string, any>): Promise<ToolResult> {
  switch (name) {
    case 'remember': {
      const memOpts: { skipConflictCheck?: boolean; bundleMode?: boolean; inferFalse?: boolean } = {};
      if (args.mode === 'index') memOpts.skipConflictCheck = true;
      else if (args.mode === 'bundle') memOpts.bundleMode = true;
      else if (args.mode === 'raw') memOpts.inferFalse = true;
      const memories = await addMemoryWithConflictCheck(args.text, args.project, memOpts);
      if (Array.isArray(memories) && memories[0]?.id === 'duplicate') {
        const conflicts = memories[0].conflictsWith;
        if (conflicts && conflicts.length > 0) {
          const list = conflicts.map(c => `${c.id} (sim ${c.score.toFixed(2)})`).join(', ');
          return text(`Memory skipped — conflicts with: ${list}`);
        }
        return text('Memory skipped — duplicate of existing memory.');
      }
      if (Array.isArray(memories) && memories[0]?.id === 'rejected') {
        return text(`Memory rejected — reason: ${memories[0].reason ?? 'quality below threshold'}`);
      }
      const summary =
        Array.isArray(memories) && memories.length > 0
          ? memories.map(m => `- ${m.memory} (id: ${m.id})`).join('\n')
          : 'Memory saved.';
      return text(`Remembered${args.project ? ` [${args.project}]` : ' [global]'}:\n${summary}`);
    }

    case 'recall': {
      const memories = await searchMemory(args.query, args.project, args.limit);
      if (!Array.isArray(memories) || memories.length === 0) {
        return text(`No memories found for: "${args.query}"${args.project ? ` in project ${args.project}` : ''}`);
      }
      const formatted = memories
        .map(m => `- ${m.memory} (id: ${m.id}${m.score ? `, score: ${m.score.toFixed(2)}` : ''})`)
        .join('\n');
      return text(`Found ${memories.length} memory/memories${args.project ? ` [${args.project}]` : ' [global]'}:\n${formatted}`);
    }

    case 'forget': {
      await deleteMemory(args.memory_id);
      return text(`Memory ${args.memory_id} deleted.`);
    }

    case 'update_memory': {
      const result = await updateMemory(args.id, args.memory, args.project);
      return text(`Memory updated. New ID: ${result.id}`);
    }

    case 'list_memories': {
      const memories = await getMemories(args.project, args.limit);
      if (!Array.isArray(memories) || memories.length === 0) {
        return text(`No memories stored${args.project ? ` for project ${args.project}` : ' globally'}.`);
      }
      const formatted = memories.map(m => `- ${m.memory} (id: ${m.id})`).join('\n');
      return text(`${memories.length} memory/memories${args.project ? ` [${args.project}]` : ' [global]'}:\n${formatted}`);
    }

    case 'scan_memories': {
      if (!args.project) return err('project is required for memory scan');
      const report = await scanAndCleanProjectMemories(args.project);
      return text(JSON.stringify(report, null, 2));
    }

    case 'graph_query': {
      const ctx = await graphQuery(args.query ?? '', { maxDepth: args.depth, maxNodes: args.maxNodes });
      return text(JSON.stringify(ctx));
    }

    case 'graph_stats': {
      return text(JSON.stringify(await cachedGetStats()));
    }

    case 'pgs_query': {
      if (!args.query) return err('query required');
      const pgsGraph = await cachedGetGraphForPGS();
      if (pgsGraph.nodes.length === 0) return err('Graph is empty');
      const providers = createPGSProviders();
      const pgsEngine = new PGSEngine({ ...providers, sessionsDir: PGS_SESSIONS_DIR });
      const result = await pgsEngine.execute(args.query, pgsGraph, {
        mode: args.mode,
        sessionId: args.sessionId,
      });
      return text(JSON.stringify(result, null, 2));
    }

    case 'pgs_stats': {
      const pgsGraph = await cachedGetGraphForPGS();
      const providers = createPGSProviders();
      const pgsEngine = new PGSEngine({ ...providers, sessionsDir: PGS_SESSIONS_DIR });
      const partitions = pgsEngine.partition(pgsGraph);
      return text(
        JSON.stringify(
          {
            nodes: pgsGraph.nodes.length,
            edges: pgsGraph.edges.length,
            partitions: partitions.length,
            partitionSummaries: partitions.map(p => ({
              id: p.id,
              nodeCount: p.nodeCount,
              keywords: p.keywords.slice(0, 5),
              summary: p.summary?.substring(0, 80),
            })),
          },
          null,
          2
        )
      );
    }

    case 'seed_extract': {
      try {
        const output = await extractSeed({
          type: args.type,
          source: args.source,
          rawText: args.rawText,
          project: args.project,
        });
        return text(
          JSON.stringify({
            success: true,
            id: output.id,
            title: output.title,
            summary: output.summary,
            facts_count: output.facts.length,
            entities_count: output.entities.length,
            message: `Extracted ${output.facts.length} facts and ${output.entities.length} entities from "${output.title}"`,
          })
        );
      } catch (e: unknown) {
        return err(`Seed extraction failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    case 'list_seeds': {
      return text(JSON.stringify(listSeeds(args.project)));
    }

    default:
      return err(`Unknown tool: ${name}`);
  }
}

async function main(): Promise<void> {
  await initGraph();
  startMemoryMaintenance();
  startDedupSweep();
  startMemoryReaper();

  const mcpServer = new Server({ name: 'lain-memory', version: '0.1.0' }, { capabilities: { tools: {} } });

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      return await handleTool(request.params.name, (request.params.arguments ?? {}) as Record<string, any>);
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : String(e));
    }
  });

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  // stderr only — stdout is the MCP transport.
  console.error('[lain-memory MCP] ready (12 tools, in-process backends)');
}

main().catch(e => {
  console.error('[lain-memory MCP] fatal boot error:', e);
  process.exit(1);
});
