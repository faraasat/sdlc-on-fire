import { describe, expect, it } from 'vitest';
import { agentManagerPackage, agentManagerDependencies } from './index.js';

describe('@sdlc-on-fire/agent-manager', () => {
  it('reports its own npm name', () => {
    expect(agentManagerPackage.name).toBe('@sdlc-on-fire/agent-manager');
  });

  it('resolves every declared workspace dependency to a real package', () => {
    expect(agentManagerDependencies.map((p) => p.name)).toEqual(agentManagerPackage.dependsOn);
  });
});
