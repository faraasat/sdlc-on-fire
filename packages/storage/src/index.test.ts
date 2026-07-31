import { describe, expect, it } from 'vitest';
import { storagePackage, storageDependencies } from './index.js';

describe('@sdlc-on-fire/storage', () => {
  it('reports its own npm name', () => {
    expect(storagePackage.name).toBe('@sdlc-on-fire/storage');
  });

  it('resolves every declared workspace dependency to a real package', () => {
    expect(storageDependencies.map((p) => p.name)).toEqual(storagePackage.dependsOn);
  });
});
