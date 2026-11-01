/**
 * Prefix of every step line the `create` command writes to stderr, so a
 * caller drawing progress can tell the runner's steps from the warnings and
 * debug dumps the engine prints on the same stream.
 */
export const STEP_MARK = "» ";
