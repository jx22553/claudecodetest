import type { ExtensionContext } from '@nimbalyst/extension-sdk';
import { ProjectExplorerEditor } from './ProjectExplorerEditor';
import { aiTools } from './aiTools';
import { setServices } from './host';
import './styles.css';

// Components referenced by manifest.contributions.customEditors
export const components = {
  ProjectExplorerEditor,
};

// AI tools referenced by manifest.contributions.aiTools
export { aiTools };

export function activate(context: ExtensionContext) {
  // Capture host services so the editor component (which only receives `host`)
  // can scan the filesystem and call AI models.
  setServices(context.services);
  console.log('Project Explorer activated');
}

export function deactivate() {
  console.log('Project Explorer deactivated');
}
