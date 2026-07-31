import { describe, expect, it } from 'vitest';
import { cliPackage, cliDependencies } from './index.js';

describe('sdlc-on-fire', () => {
  it('reports its own npm name', () => {
    expect(cliPackage.name).toBe('sdlc-on-fire');
  });

  it('resolves every declared workspace dependency to a real package', () => {
    expect(cliDependencies.map((p) => p.name)).toEqual(cliPackage.dependsOn);
  });
});
