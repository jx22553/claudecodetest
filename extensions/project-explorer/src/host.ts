// Bridges the host services (filesystem, AI) captured in activate() to the
// editor component, which only receives `host` (no services) from Nimbalyst.

import type { ExtensionContext } from '@nimbalyst/extension-sdk';

export type Services = ExtensionContext['services'];

let services: Services | undefined;

export function setServices(next: Services): void {
  services = next;
}

export function getServices(): Services | undefined {
  return services;
}
