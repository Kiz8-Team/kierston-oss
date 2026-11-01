/**
 * The small pieces of interactive state a page is built from: a cursor over
 * a list, a scroll position in a document, a text field being edited, and a
 * filter being typed. Each knows which keys it owns so pages do not re-derive
 * arrow handling.
 */

import type { Key } from "./screen.ts";
import { clampScroll, scrollTo } from "./widgets.ts";
import { paint } from "../format.ts";

/** A cursor over rows, kept in view. */
export class ListState {
  cursor = 0;
  offset = 0;

  /** Move the cursor; `page` is how far pageup/pagedown go. ↑↓ wrap round the ends, paging stops at them. */
  onKey(key: Key, count: number, page: number): boolean {
    switch (key.name) {
      case "up":
        this.set(this.cursor <= 0 ? count - 1 : this.cursor - 1, count);
        return true;
      case "down":
        this.set(this.cursor >= count - 1 ? 0 : this.cursor + 1, count);
        return true;
      case "pageup":
        this.set(this.cursor - page, count);
        return true;
      case "pagedown":
        this.set(this.cursor + page, count);
        return true;
      case "home":
        this.set(0, count);
        return true;
      case "end":
        this.set(count - 1, count);
        return true;
      default:
        return false;
    }
  }

  set(value: number, count: number): void {
    this.cursor = count === 0 ? 0 : Math.max(0, Math.min(value, count - 1));
  }

  reset(): void {
    this.cursor = 0;
    this.offset = 0;
  }

  /** Clamp to the rows on screen and return the first visible row. */
  window(count: number, height: number): number {
    this.set(this.cursor, count);
    this.offset = scrollTo(this.cursor, this.offset, Math.max(1, height), count);
    return this.offset;
  }
}

/** A scroll position in a document taller than the pane. */
export class DocState {
  scroll = 0;
  /** Set by whoever last drew the pane, so paging matches the screen. */
  height = 10;

  onKey(key: Key, lines: number): boolean {
    const page = Math.max(1, this.height - 1);
    switch (key.name) {
      case "up":
        this.scroll = clampScroll(this.scroll - 1, lines, this.height);
        return true;
      case "down":
        this.scroll = clampScroll(this.scroll + 1, lines, this.height);
        return true;
      case "pageup":
        this.scroll = clampScroll(this.scroll - page, lines, this.height);
        return true;
      case "pagedown":
        this.scroll = clampScroll(this.scroll + page, lines, this.height);
        return true;
      case "home":
        this.scroll = 0;
        return true;
      case "end":
        this.scroll = clampScroll(lines, lines, this.height);
        return true;
      default:
        return false;
    }
  }
}

/** A line of text being edited in place, with a caret. */
export class Editor {
  caret: number;

  constructor(public text: string) {
    this.caret = text.length;
  }

  /** Returns "done" on ⏎, "cancel" on esc, and "typing" for everything else. */
  onKey(key: Key): "done" | "cancel" | "typing" {
    switch (key.name) {
      case "enter":
        return "done";
      case "escape":
        return "cancel";
      case "left":
        this.caret = Math.max(0, this.caret - 1);
        break;
      case "right":
        this.caret = Math.min(this.text.length, this.caret + 1);
        break;
      case "home":
        this.caret = 0;
        break;
      case "end":
        this.caret = this.text.length;
        break;
      case "backspace":
        if (this.caret > 0) {
          this.text = this.text.slice(0, this.caret - 1) + this.text.slice(this.caret);
          this.caret -= 1;
        }
        break;
      case "delete":
        this.text = this.text.slice(0, this.caret) + this.text.slice(this.caret + 1);
        break;
      case "char":
        if (key.ch) {
          this.text = this.text.slice(0, this.caret) + key.ch + this.text.slice(this.caret);
          this.caret += key.ch.length;
        }
        break;
      case "u":
        if (key.ctrl) {
          this.text = this.text.slice(this.caret);
          this.caret = 0;
        }
        break;
      default:
        break;
    }
    return "typing";
  }

  /** The text with the caret drawn in. */
  render(): string {
    return `${this.text.slice(0, this.caret)}${paint("▌", "cyan")}${this.text.slice(this.caret)}`;
  }
}

/** A `/` filter over a list: typed in place, cleared with esc. */
export class Filter {
  text = "";
  typing = false;

  /** Consumes `/`, the typed characters, and the esc that clears it. */
  onKey(key: Key): boolean {
    if (this.typing) {
      if (key.name === "escape") {
        this.text = "";
        this.typing = false;
        return true;
      }
      if (key.name === "enter" || key.name === "tab") {
        this.typing = false;
        return true;
      }
      if (key.name === "backspace") {
        this.text = this.text.slice(0, -1);
        return true;
      }
      if (key.name === "char" && key.ch) {
        this.text += key.ch;
        return true;
      }
      // Arrows still move the list underneath while the filter is being typed.
      return false;
    }
    if (key.name === "char" && key.ch === "/") {
      this.typing = true;
      return true;
    }
    if (key.name === "escape" && this.text !== "") {
      this.text = "";
      return true;
    }
    return false;
  }

  get active(): boolean {
    return this.typing || this.text !== "";
  }

  matches(text: string): boolean {
    return this.text === "" || text.toLowerCase().includes(this.text.toLowerCase());
  }

  /** How the filter reads on screen: `/needle▌` while typing. */
  render(): string {
    if (this.typing) return `${paint("/", "bold")}${this.text}${paint("▌", "cyan")}`;
    return `${paint("/", "grey")}${this.text}`;
  }
}
