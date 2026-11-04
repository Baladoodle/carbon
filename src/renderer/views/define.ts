import type { ComponentType } from 'react';

/**
 * A view's definition. Each view lives in its own folder, `views/<id>/`, and
 * default-exports `defineView({...})` from `views/<id>/view.tsx`; the registry
 * finds it automatically. (Kept apart from registry.ts to avoid an import cycle.)
 */
export interface ViewDef {
  /** Folder name and stable id: `column`, `climate`, `codex`, … */
  id: string;
  label: string;
  /** The rail key, `1`–`9`. */
  key: string;
  /** Rail order (ascending). */
  order: number;
  /** The rail icon (16px, currentColor; see ui/icons.tsx). The rail shows it with a tooltip. */
  icon: ComponentType;
  component: ComponentType;
}

export const defineView = (def: ViewDef): ViewDef => def;
