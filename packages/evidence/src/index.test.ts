import { describe, expect, it } from 'vitest';
import { evidencePackage, evidenceDependencies } from './index.js';

describe('@sdlc-on-fire/evidence', () => {
  it('reports its own npm name', () => {
    expect(evidencePackage.name).toBe('@sdlc-on-fire/evidence');
  });

  it('resolves every declared workspace dependency to a real package', () => {
    expect(evidenceDependencies.map((p) => p.name)).toEqual(evidencePackage.dependsOn);
  });
});
