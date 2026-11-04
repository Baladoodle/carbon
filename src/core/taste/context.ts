import type { Taste, World } from '../model/world';
import { allJudgements } from '../spreads/record';

/**
 * Taste as it goes into every AI request (docs/EXPERIENCE.md §6, SYSTEM.md
 * §8): the active rules, the top patterns, and examples of each kill reason.
 * Pure and deterministic, so it can sit before a cache breakpoint: it changes
 * only when taste or judgements change.
 */

export interface TasteContext {
  rules: { id: string; text: string }[];
  patterns: { id: string; text: string; promoted: boolean; examples: string[] }[];
  kills: { key: string; label: string; count: number; examples: string[] }[];
}

/** Patterns that go into a request. */
export const TOP_PATTERNS = 6;
/** Examples per kill reason. */
export const KILL_EXAMPLES = 3;

/**
 * Rules switched on for a request. `ruleIds` is the per-spread switch: when
 * given, exactly those rules (that exist); otherwise every enabled rule.
 */
export function activeRules(taste: Taste, ruleIds?: readonly string[]): Taste['rules'] {
  if (ruleIds) {
    const on = new Set(ruleIds);
    return taste.rules.filter((r) => on.has(r.id));
  }
  return taste.rules.filter((r) => r.enabled);
}

const strengthOf = (p: Taste['patterns'][number]): number =>
  typeof p.strength === 'number' ? p.strength : 0;

/** Promoted patterns first, then proposed by strength; dismissed never. Ties by id. */
export function topPatterns(taste: Taste, n = TOP_PATTERNS): Taste['patterns'] {
  return taste.patterns
    .filter((p) => p.status !== 'dismissed')
    .sort(
      (a, b) =>
        Number(b.status === 'promoted') - Number(a.status === 'promoted') ||
        strengthOf(b) - strengthOf(a) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, n);
}

export function tasteContext(world: World, ruleIds?: readonly string[]): TasteContext {
  const kills = allJudgements(world).filter((j) => j.judgement.verdict === 'kill');
  const examplesFor = (key: string): string[] => {
    const names = kills
      .filter((k) => k.judgement.reason === key)
      .reverse() // most recent first
      .map((k) =>
        k.judgement.note ? `${k.candidate.name} (${k.judgement.note})` : k.candidate.name,
      );
    return [...new Set(names)].slice(0, KILL_EXAMPLES);
  };
  return {
    rules: activeRules(world.taste, ruleIds).map((r) => ({ id: r.id, text: r.text })),
    patterns: topPatterns(world.taste).map((p) => ({
      id: p.id,
      text: p.text,
      promoted: p.status === 'promoted',
      examples: p.examples.slice(0, 3),
    })),
    kills: world.taste.reasons
      .filter((r) => r.count > 0)
      .map((r) => ({ key: r.key, label: r.label, count: r.count, examples: examplesFor(r.key) }))
      .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1)),
  };
}

/** The taste block of a prompt, as text. Empty taste gives a one-line block saying so. */
export function renderTaste(t: TasteContext): string {
  const lines: string[] = ['<taste>'];
  if (t.rules.length === 0 && t.patterns.length === 0 && t.kills.length === 0)
    lines.push('No rules or patterns yet.');
  if (t.rules.length > 0) {
    lines.push('Rules (hard constraints, by id):');
    for (const r of t.rules) lines.push(`- [${r.id}] ${r.text}`);
  }
  if (t.patterns.length > 0) {
    lines.push('Patterns learned from past keeps and kills:');
    for (const p of t.patterns)
      lines.push(
        `- ${p.text}${p.promoted ? ' (confirmed)' : ''}${p.examples.length > 0 ? ` e.g. ${p.examples.join(', ')}` : ''}`,
      );
  }
  if (t.kills.length > 0) {
    lines.push('Things killed before, by reason (avoid these):');
    for (const k of t.kills)
      lines.push(
        `- ${k.label} (${k.count}×)${k.examples.length > 0 ? `: ${k.examples.join(', ')}` : ''}`,
      );
  }
  lines.push('</taste>');
  return lines.join('\n');
}
