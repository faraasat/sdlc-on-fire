import { z } from 'zod';
import { ExternalRefSchema } from '@sdlc-on-fire/core';

/**
 * The tool-independent IR every parser writes into (P2-IMP-01, `.research/10 §3`).
 *
 * **It mirrors our object model, not a generic document bag.** That is the whole
 * reason the writer can order writes by dependency: a node that says it is a
 * `task` whose parent is an `epic` tells the writer what has to exist first. A
 * bag of `{path, text}` would push that ordering problem onto every parser, and
 * each of the four tools would solve it differently.
 *
 * **Format drift is the norm, not the exception.** Three of the four tools
 * studied shipped a breaking rewrite or a community fork schism within about a
 * year (`.research/10 §2`). So a parser is versioned per *dialect*, and the IR
 * is the stable thing in the middle — the layer that lets a GSD-2 rewrite cost
 * one parser rather than one importer.
 */

export const IR_KINDS = [
  'constitution',
  'epic',
  'story',
  'task',
  'spec',
  'change',
  'verification',
] as const;

export const IrKindSchema = z.enum(IR_KINDS);
export type IrKind = z.infer<typeof IrKindSchema>;

export const RELATION_TYPES = ['parent', 'blocks', 'relates-to', 'delta-of'] as const;
export const RelationTypeSchema = z.enum(RELATION_TYPES);

/**
 * A pointer to another node **by external ref**, never by our id.
 *
 * Our ids do not exist yet when a parser runs — they are assigned by the writer.
 * A parser that emitted them would be inventing identity for content it is
 * merely reading, and two parsers would invent conflicting ones.
 */
export const RelationSchema = z
  .object({
    type: RelationTypeSchema,
    targetExternalRef: z.string().min(1),
  })
  .strict();

export const IrNodeSchema = z
  .object({
    kind: IrKindSchema,
    title: z.string().min(1),
    /** Normalised markdown. Never the raw file — parsers strip tool-specific chrome. */
    body: z.string(),
    /**
     * Fields a parser believes belong in frontmatter, unvalidated.
     *
     * `Hints`, deliberately. A parser reads someone else's format and can be
     * wrong; the writer decides what actually becomes frontmatter. Letting a
     * parser write frontmatter directly would make every tool's quirks our
     * schema's problem.
     */
    frontmatterHints: z.record(z.string(), z.unknown()).default({}),
    externalRef: ExternalRefSchema,
    /**
     * `FR-003`, `SC-001`, `REQ-12` — kept verbatim, **never renumbered**.
     *
     * Teams reference these in commits, PRs and conversations. An import that
     * renumbers them silently breaks every one of those references, and the
     * breakage surfaces as a human misreading a PR, not as an error.
     */
    preservedIdentifiers: z.array(z.string().min(1)).default([]),
    relations: z.array(RelationSchema).default([]),
  })
  .strict();

export type IrNode = z.infer<typeof IrNodeSchema>;
export type Relation = z.infer<typeof RelationSchema>;

/** The canonical string form of an external ref — the idempotency key. */
export function externalRefKey(ref: z.infer<typeof ExternalRefSchema>): string {
  return `${ref.source_tool}:${ref.source_path}:${ref.source_id_or_hash}`;
}

/**
 * Write order (`.research/10 §3`): a node may only reference something already
 * written. Constitution first because everything can cite it; verification last
 * because it points at work that must exist to be verified.
 */
export const WRITE_ORDER: readonly IrKind[] = [
  'constitution',
  'spec',
  'epic',
  'story',
  'task',
  'change',
  'verification',
];
