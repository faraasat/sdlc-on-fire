import { describe, expect, it } from 'vitest';
import { corePackage } from './index.js';

describe('@sdlc-on-fire/core', () => {
  it('reports its own npm name', () => {
    expect(corePackage.name).toBe('@sdlc-on-fire/core');
  });

  it('declares no workspace dependencies', () => {
    expect(corePackage.dependsOn).toHaveLength(0);
  });
});
