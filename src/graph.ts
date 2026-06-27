/**
 * graph.ts — Dependency graph operations for Phase 4: Dependency Graph and Catalog.
 *
 * Provides three capabilities:
 *
 *   1. buildDependencyGraph(entries)
 *      Converts a flat list of RegistryEntry records into an adjacency-list
 *      graph keyed by fullyQualifiedId.
 *
 *   2. detectCycles(graph, newEntry)
 *      DFS-based cycle detection. Called by publishManifest() on the full
 *      updated graph before saveRegistry() is called. Throws CycleError
 *      if a cycle is found — the registry file is never written.
 *
 *   3. getImpactedCapabilities(graph, fqId)
 *      Reverses the graph and runs BFS from the seed to find all capabilities
 *      that (directly or transitively) depend on the given fqId.
 *
 * All functions are pure — no filesystem access, no side effects.
 * Exported types are also used by catalog.ts and the CLI.
 */

import type { RegistryEntry } from './types'

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Adjacency list: fullyQualifiedId → Set of fullyQualifiedIds it depends on.
 * An edge A → B means "A depends on B".
 */
export type DependencyGraph = Map<string, Set<string>>

/**
 * Thrown by detectCycles() when a circular dependency is found.
 * The cyclePath array contains the ordered list of fullyQualifiedIds
 * that form the cycle, starting and ending at the same node.
 *
 * @example
 * // A → B → C → A
 * err.cyclePath === ['my-app/a', 'my-app/b', 'my-app/c', 'my-app/a']
 */
export class CycleError extends Error {
  public readonly cyclePath: string[]

  constructor(cyclePath: string[]) {
    super(
      `Circular dependency detected: ${cyclePath.join(' → ')}\n` +
      `Fix: remove one of the dependsOn declarations that forms this cycle.`,
    )
    this.name = 'CycleError'
    this.cyclePath = cyclePath
  }
}

// ── Graph construction ────────────────────────────────────────────────────────

/**
 * Build a dependency graph from a flat list of registry entries.
 *
 * Each entry with `dependsOn` contributes directed edges:
 *   entry.fullyQualifiedId → each id in entry.dependsOn
 *
 * Entries with no `dependsOn` (or an empty array) are still added as nodes
 * with an empty edge set so impact traversal can find them as non-roots.
 *
 * Dangling references (dependsOn contains an fqId not in entries) are added
 * as nodes with empty edge sets — no error is thrown. This handles the case
 * where a dependency is defined in a different manifest/app.
 *
 * @param entries - All registry entries to include in the graph.
 * @returns DependencyGraph adjacency list.
 */
export function buildDependencyGraph(entries: RegistryEntry[]): DependencyGraph {
  const graph: DependencyGraph = new Map()

  // First pass: add all known nodes
  for (const entry of entries) {
    if (!graph.has(entry.fullyQualifiedId)) {
      graph.set(entry.fullyQualifiedId, new Set())
    }
  }

  // Second pass: add edges and dangling dependency nodes
  for (const entry of entries) {
    if (!entry.dependsOn?.length) continue
    const deps = graph.get(entry.fullyQualifiedId)!
    for (const dep of entry.dependsOn) {
      deps.add(dep)
      // Ensure dangling references exist as nodes
      if (!graph.has(dep)) {
        graph.set(dep, new Set())
      }
    }
  }

  return graph
}

// ── Cycle detection ───────────────────────────────────────────────────────────

/**
 * Detect cycles in the dependency graph after applying a new or updated entry.
 *
 * Uses iterative DFS with a `visited` set (fully explored nodes) and an
 * `inStack` set (nodes currently on the DFS path). A back edge — an edge to
 * a node already in `inStack` — indicates a cycle.
 *
 * The cycle path is reconstructed from a `parent` map: starting from the
 * back-edge target, walk the parent chain until we return to the same node,
 * then append the target again to close the loop.
 *
 * Called by publishManifest() on the full proposed graph (all entries
 * including the new/updated one) *before* writing the registry file.
 * If this throws, the registry is not modified.
 *
 * @param graph - The full proposed dependency graph (post-update).
 * @throws CycleError if any cycle is detected.
 */
export function detectCycles(graph: DependencyGraph): void {
  const visited = new Set<string>()
  const inStack = new Set<string>()
  // parent map for cycle path reconstruction
  const parent  = new Map<string, string | null>()

  for (const startNode of graph.keys()) {
    if (visited.has(startNode)) continue

    // Iterative DFS using an explicit stack of [node, iterator] pairs.
    // Each entry tracks which neighbours we still need to visit.
    const stack: Array<[string, Iterator<string>]> = []
    inStack.add(startNode)
    parent.set(startNode, null)
    stack.push([startNode, graph.get(startNode)![Symbol.iterator]()])

    while (stack.length > 0) {
      const [node, iter] = stack[stack.length - 1]
      const next = iter.next()

      if (next.done) {
        // All neighbours explored — pop and mark fully visited
        stack.pop()
        inStack.delete(node)
        visited.add(node)
      } else {
        const neighbour = next.value

        if (inStack.has(neighbour)) {
          // Back edge found — reconstruct cycle path
          const cyclePath = reconstructCyclePath(neighbour, node, parent)
          throw new CycleError(cyclePath)
        }

        if (!visited.has(neighbour)) {
          inStack.add(neighbour)
          parent.set(neighbour, node)
          const neighbourEdges = graph.get(neighbour) ?? new Set<string>()
          stack.push([neighbour, neighbourEdges[Symbol.iterator]()])
        }
      }
    }
  }
}

/**
 * Reconstruct the cycle path from the parent map.
 *
 * @param cycleStart - The node where the back edge was detected (the target).
 * @param cycleEnd   - The node where the back edge originates (the source).
 * @param parent     - Map from node → its DFS parent.
 * @returns Ordered array of fqIds forming the cycle, first === last.
 */
function reconstructCyclePath(
  cycleStart: string,
  cycleEnd:   string,
  parent:     Map<string, string | null>,
): string[] {
  const path: string[] = [cycleStart]
  let current = cycleEnd

  // Walk back from cycleEnd through parents until we reach cycleStart
  while (current !== cycleStart) {
    path.unshift(current)
    const p = parent.get(current)
    if (p === null || p === undefined) break  // safety: should not happen
    current = p
  }

  path.unshift(cycleStart)  // close the loop
  return path
}

// ── Impact analysis ───────────────────────────────────────────────────────────

/**
 * Find all capabilities that directly or transitively depend on the given
 * fullyQualifiedId.
 *
 * Builds the reverse graph (all edges flipped) and runs BFS from the seed
 * node. Returns all reachable nodes excluding the seed itself.
 *
 * @example
 * // Graph: order_summary → get_order, checkout_flow → get_order
 * getImpactedCapabilities(graph, 'my-shop/get_order')
 * // → ['my-shop/order_summary', 'my-shop/checkout_flow']
 *
 * @param graph - The dependency graph (forward edges).
 * @param fqId  - The capability whose dependents you want to find.
 * @returns Sorted array of fullyQualifiedIds that depend on fqId.
 */
export function getImpactedCapabilities(
  graph: DependencyGraph,
  fqId:  string,
): string[] {
  // Build reverse graph: B → A means "B is depended on by A" in the forward graph,
  // so reversing gives us A → B meaning "if B changes, A is affected".
  const reverse: DependencyGraph = new Map()
  for (const [node, deps] of graph.entries()) {
    if (!reverse.has(node)) reverse.set(node, new Set())
    for (const dep of deps) {
      if (!reverse.has(dep)) reverse.set(dep, new Set())
      reverse.get(dep)!.add(node)
    }
  }

  // BFS from seed on the reversed graph
  const impacted = new Set<string>()
  const queue: string[] = [fqId]
  const seen = new Set<string>([fqId])

  while (queue.length > 0) {
    const current = queue.shift()!
    const dependents = reverse.get(current) ?? new Set<string>()
    for (const dependent of dependents) {
      if (!seen.has(dependent)) {
        seen.add(dependent)
        impacted.add(dependent)
        queue.push(dependent)
      }
    }
  }

  return [...impacted].sort()
}