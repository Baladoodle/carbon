import type { ViewDef } from './define';

/**
 * The view registry. Each view lives in its own folder, `views/<id>/`, and
 * exports its definition (see define.ts) as the default export of
 * `views/<id>/view.tsx`. The shell finds them with `import.meta.glob`: adding a
 * view never touches a shared file.
 */
export type { ViewDef } from './define';

const modules = import.meta.glob<{ default: ViewDef }>('./*/view.tsx', { eager: true });

/** Every registered view, in rail order. */
export const VIEWS: ViewDef[] = Object.entries(modules)
  .map(([path, m]) => {
    const folder = /^\.\/([^/]+)\//.exec(path)?.[1];
    if (m.default.id !== folder) throw new Error(`view in ${path} must have id "${folder ?? ''}"`);
    return m.default;
  })
  .sort((a, b) => a.order - b.order);

export const viewById = (id: string): ViewDef | undefined => VIEWS.find((v) => v.id === id);
