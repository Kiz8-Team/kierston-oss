/** The keys, on one page. */

import type { Ctx, Hint, Page } from "../page.ts";
import type { Key } from "../screen.ts";
import { DocState } from "../state.ts";
import { viewport } from "../widgets.ts";

const HELP = [
  "",
  " Navigation",
  "   ↑↓            move           ⏎ open / edit / toggle       esc back",
  "   ←→            tabs (Runs · Series · New run · New series · Sweeps) when nothing is open",
  "                 run: Tasks · Problems · Families;  task: sections",
  "   /             filter a list; esc clears it                 ? keys           q back, or quit",
  "",
  " Actions",
  "   s             score the selected run, in any state",
  "   n             new run of the selected series (Runs), or new series (Series)",
  "   X  R          stop / resume the run (resume runs here)",
  "   A             abort the selected running task; the rest of the run continues",
  "   T             rerun the selected task; keeps the previous attempt, rescores the run",
  "   D             delete the selected run and free its id and name (Runs), or the selected",
  "                 series with its runs, generated config and unshared kdiffs (Series)",
  "   r             recheck preflight on the new-run form",
  "   ⏎ New sweep   (Sweeps) one task, a run per model, named after the model",
  "   D             delete the selected sweep record (Sweeps); its runs are kept",
  "",
  " Forms",
  "   ↑↓            field          ⏎ edit / open / press",
  "   editing       ←→ caret       ⏎ keep       esc discard",
  "   chooser       ↑↓ move        space toggle esc done",
  "",
  " Tasks chooser    ←→ one family's count · typed number every family · a all · x none",
  "",
  " Runs",
  "   started run   opens its screen; esc returns to Runs",
  "   finished run  scored automatically, including runs from other terminals",
  "   quit          stops runs started in this TUI and their containers",
  "",
];

export class HelpPage implements Page {
  private readonly doc = new DocState();

  constructor(private readonly ctx: Ctx) {}

  title(): string {
    return "Keys";
  }

  hints(): Hint[] {
    return [["↑↓", "scroll"], ["esc", "back"]];
  }

  onKey(key: Key): boolean {
    return this.doc.onKey(key, HELP.length);
  }

  body(_columns: number, height: number): string[] {
    this.doc.height = height;
    return viewport([], HELP, height, this.doc.scroll);
  }
}
