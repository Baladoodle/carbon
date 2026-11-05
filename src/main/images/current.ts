import type { MainImageGateway } from './gateway';

/**
 * The image gateway this run created (the images module sets it on start), for
 * other main-process modules that use images: the agent socket's image tools
 * (src/main/agent). Null before the module starts, and when it stops.
 */
let current: MainImageGateway | null = null;

export const setImageGateway = (g: MainImageGateway | null): void => {
  current = g;
};

export const imageGateway = (): MainImageGateway | null => current;
