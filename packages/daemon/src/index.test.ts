import { describe, expect, it } from 'vitest';
import { daemonPackage, daemonDependencies } from './index.js';

describe('@sdlc-on-fire/daemon', () => {
  it('reports its own npm name', () => {
    expect(daemonPackage.name).toBe('@sdlc-on-fire/daemon');
  });

  it('resolves every declared workspace dependency to a real package', () => {
    expect(daemonDependencies.map((p) => p.name)).toEqual(daemonPackage.dependsOn);
  });
});
