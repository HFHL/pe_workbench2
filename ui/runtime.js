/**
 * Late-bound UI actions.
 *
 * Modules own their domain and register the actions other domains may call.
 * This avoids import cycles between chat, materials and previews while keeping
 * state itself in the store rather than in ad-hoc globals.
 */
export const runtime = {};
