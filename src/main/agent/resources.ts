import { toolByName, type ToolContext } from './tools';

/**
 * Resources (docs/MCP.md §2): the reads that are natural to attach as context,
 * the same data as their tools. Each read runs the tool against the current
 * world, so a resource is never stale.
 */
export const RESOURCES = [
  {
    uri: 'carbon://world/summary',
    name: 'world-summary',
    title: 'World summary',
    description: 'Bands, counts per kind and state, open notes, spreads, numbers and taste.',
    mimeType: 'application/json',
  },
  {
    uri: 'carbon://schema',
    name: 'schema',
    title: 'Schema',
    description: 'Kinds, fields, attributes, relation types and the lifecycle.',
    mimeType: 'application/json',
  },
  {
    uri: 'carbon://taste',
    name: 'taste',
    title: 'Taste',
    description: 'Rules, kill reasons, learned patterns and the art direction.',
    mimeType: 'application/json',
  },
  {
    uri: 'carbon://numbers',
    name: 'numbers',
    title: 'Numbers',
    description: 'Variables, formulas with their values, curves and errors.',
    mimeType: 'application/json',
  },
] as const;

export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'carbon://entity/{id}',
    name: 'entity',
    title: 'Entity',
    description: 'One entity in full (as get_entity).',
    mimeType: 'application/json',
  },
] as const;

const BY_URI: Record<string, [string, Record<string, unknown>]> = {
  'carbon://world/summary': ['world_summary', {}],
  'carbon://schema': ['get_schema', {}],
  'carbon://taste': ['get_taste', {}],
  'carbon://numbers': ['get_numbers', {}],
};

/** The resource's JSON text, or null when there's no such resource. */
export async function readResource(uri: string, ctx: ToolContext): Promise<string | null> {
  const entity = /^carbon:\/\/entity\/([^/?#]+)$/.exec(uri);
  const [name, args] = entity
    ? ['get_entity', { id: decodeURIComponent(entity[1] as string) }]
    : (BY_URI[uri] ?? [null, {}]);
  const def = name ? toolByName(name) : undefined;
  if (!def) return null;
  const input = def.input.safeParse(args);
  if (!input.success) return null;
  const out = await def.run(ctx, input.data);
  return out.ok ? JSON.stringify(out.data, null, 1) : null;
}
