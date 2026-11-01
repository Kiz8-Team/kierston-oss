/** A schedule may move earlier, but its events may never spill into tomorrow. */
export class DayBoundaryError extends Error {}
