import { describe, expect, it } from 'vitest';
import { contextPackage, contextDependencies } from './index.js';

describe('@sdlc-on-fire/context', () => {
  it('reports its own npm name', () => {
    expect(contextPackage.name).toBe('@sdlc-on-fire/context');
  });

  it('resolves every declared workspace dependency to a real package', () => {
    expect(contextDependencies.map((p) => p.name)).toEqual(contextPackage.dependsOn);
  });
});
