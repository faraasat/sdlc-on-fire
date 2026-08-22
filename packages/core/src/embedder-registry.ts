/**
 * Choosing an embedder (P5-ECO-03).
 *
 * The local model from P1-CTX-04 is the default and stays the default. This
 * adds the ability to opt into a hosted one — Voyage's code models being the
 * obvious candidate — behind an explicit choice, and it exists mostly to make
 * three consequences of that choice impossible to take accidentally.
 *
 * **A hosted embedder sends your source to somebody else.** That is the whole
 * feature and the whole risk: retrieval quality improves because a larger model
 * read your code, which it could only do because your code left the machine.
 * Nothing here enables one implicitly, no detection turns one on, and the
 * descriptor carries `sendsContentOffMachine` so a surface that has to warn can
 * ask rather than hardcode a list of names it will forget to update.
 *
 * **Vectors from two models are not comparable.** Cosine distance between a
 * local 384-dimension embedding and a hosted 1024-dimension one is not a worse
 * answer, it is a meaningless one — and the failure is silent, because the
 * arithmetic succeeds. Switching embedders therefore invalidates the corpus,
 * and `switchRequiresReindex` says so rather than leaving it to be discovered
 * as bad search results weeks later.
 *
 * **An API key is a runtime input, never configuration.** The descriptor names
 * the environment variable it needs; it never holds the value, and nothing in
 * this module reads one.
 */

export interface EmbedderDescriptor {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  /** True when using it transmits repository content to a third party. */
  readonly sendsContentOffMachine: boolean;
  /** The environment variable holding the credential, when one is needed. */
  readonly credentialEnv?: string | undefined;
  readonly because: string;
}

/**
 * The registry.
 *
 * Explicit rather than discovered, for the same reason `COMPILE_TARGETS` is: a
 * component selected by looking around is a component nobody chose.
 */
export const EMBEDDERS: readonly EmbedderDescriptor[] = [
  {
    id: 'local',
    model: 'all-MiniLM-L6-v2',
    dimensions: 384,
    sendsContentOffMachine: false,
    because: 'runs on this machine; nothing leaves it, and it needs no account',
  },
  {
    id: 'voyage-code',
    model: 'voyage-code-3',
    dimensions: 1024,
    sendsContentOffMachine: true,
    credentialEnv: 'VOYAGE_API_KEY',
    because:
      'a code-specialised hosted model — better retrieval, and your source is sent to Voyage',
  },
];

export const DEFAULT_EMBEDDER_ID = 'local';

export function embedderById(id: string): EmbedderDescriptor | undefined {
  return EMBEDDERS.find((embedder) => embedder.id === id);
}

export interface EmbedderChoiceProblem {
  readonly field: string;
  readonly because: string;
}

/**
 * Validate a choice before anything is embedded.
 *
 * `env` is passed in rather than read, so this stays pure and a test does not
 * mutate global state to exercise a credential path.
 */
export function validateEmbedderChoice(
  id: string,
  env: Record<string, string | undefined> = {},
): readonly EmbedderChoiceProblem[] {
  const embedder = embedderById(id);
  if (embedder === undefined) {
    return [
      {
        field: 'embedder',
        because: `unknown embedder "${id}" — configured embedders are ${EMBEDDERS.map((e) => e.id).join(', ')}`,
      },
    ];
  }

  const problems: EmbedderChoiceProblem[] = [];
  if (embedder.credentialEnv !== undefined) {
    const value = env[embedder.credentialEnv];
    if (value === undefined || value.trim() === '') {
      // Refused before the first call rather than after. Discovering a missing
      // key partway through embedding a corpus leaves half a corpus embedded
      // with one model, which is the state this module exists to prevent.
      problems.push({
        field: 'credential',
        because: `${embedder.id} needs ${embedder.credentialEnv}, which is not set`,
      });
    }
  }
  return problems;
}

/**
 * Whether changing embedders invalidates the existing corpus.
 *
 * True whenever the model changes at all, not only when the dimension does.
 * Two 1024-dimension models produce vectors of the same *shape* and different
 * *meaning*, so the arithmetic succeeds and the neighbours are wrong — which is
 * strictly worse than an error, because nothing surfaces it.
 */
export function switchRequiresReindex(from: string, to: string): boolean {
  const a = embedderById(from);
  const b = embedderById(to);
  if (a === undefined || b === undefined) return true;
  return a.model !== b.model;
}

/**
 * Whether changing embedders also needs a schema migration.
 *
 * Stronger than a re-index and worth separating. The embeddings column is
 * declared `vector(384)` (`embedding.ts`), so moving to a 1024-dimension model
 * is not a re-embed — it is a DDL change, and every existing row has to go.
 * A surface that offered the switch as a setting would produce an insert error
 * on the first chunk, which is a confusing way to learn about a decision.
 */
export function switchRequiresMigration(from: string, to: string): boolean {
  const a = embedderById(from);
  const b = embedderById(to);
  if (a === undefined || b === undefined) return true;
  return a.dimensions !== b.dimensions;
}

/** What a surface should tell somebody before they opt in. */
export function embedderWarning(id: string): string | null {
  const embedder = embedderById(id);
  if (embedder === undefined || !embedder.sendsContentOffMachine) return null;
  return `${embedder.id} sends repository content to a third party (${embedder.model}). Retrieval improves because a larger model read your code, which it could only do because your code left this machine.`;
}
