import { describe, expect, it } from 'vitest';
import { dbPackage, dbDependencies } from './index.js';

describe('@sdlc-on-fire/db', () => {
  it('reports its own npm name', () => {
    expect(dbPackage.name).toBe('@sdlc-on-fire/db');
  });

  it('resolves every declared workspace dependency to a real package', () => {
    expect(dbDependencies.map((p) => p.name)).toEqual(dbPackage.dependsOn);
  });
});
