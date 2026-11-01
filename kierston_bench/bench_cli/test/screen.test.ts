import { expect, test } from "bun:test";
import { decode } from "../src/tui/screen.ts";
import { clampScroll, position, scrollTo, tabs, viewport, wrap } from "../src/tui/widgets.ts";
import { bar, duration, fit, percent, width } from "../src/format.ts";

test("arrow keys, control keys and characters all decode", () => {
  expect(decode("\x1b[A")).toEqual([{ name: "up" }]);
  expect(decode("\x1b[B\x1b[B")).toEqual([{ name: "down" }, { name: "down" }]);
  expect(decode("\t\x1b[Z")).toEqual([{ name: "tab" }, { name: "shift-tab" }]);
  expect(decode("\r")).toEqual([{ name: "enter" }]);
  expect(decode("\x03")).toEqual([{ name: "c", ctrl: true }]);
  expect(decode("q")).toEqual([{ name: "char", ch: "q" }]);
  expect(decode("\x1b")).toEqual([{ name: "escape" }]);
});

test("an escape sequence the TUI does not use is swallowed, not read as escape", () => {
  // F1 and a mouse report would otherwise decode as ESC — "go back" —
  // followed by whatever their letters happen to mean on the current screen.
  expect(decode("\x1bOP")).toEqual([]);
  expect(decode("\x1b[<0;12;30M")).toEqual([]);
  expect(decode("\x1b[Zq")).toEqual([{ name: "shift-tab" }, { name: "char", ch: "q" }]);
});

test("a paste of several keys decodes in order", () => {
  expect(decode("\x1b[Bx\r").map((key) => key.name)).toEqual(["down", "char", "enter"]);
});

test("scrolling keeps the cursor in the window", () => {
  expect(scrollTo(0, 0, 10, 100)).toBe(0);
  expect(scrollTo(15, 0, 10, 100)).toBe(6);
  expect(scrollTo(3, 6, 10, 100)).toBe(3);
  expect(scrollTo(5, 0, 10, 8)).toBe(0);
});

test("fit pads and clips to an exact width, escapes and all", () => {
  expect(width(fit("abc", 6))).toBe(6);
  expect(width(fit("abcdefgh", 4))).toBe(4);
  expect(width(fit("\x1b[1mabcdefgh\x1b[0m", 4))).toBe(4);
});

test("durations and bars read as a person would say them", () => {
  expect(duration(45_000)).toBe("45s");
  expect(duration(504_141)).toBe("8m 24s");
  expect(bar(0.5, 10)).toBe("█████░░░░░");
  expect(percent(0.333)).toBe("33.3%");
  expect(percent(null)).toBe("—");
});

test("wrapping keeps whole words and existing breaks", () => {
  expect(wrap("one two three", 7)).toEqual(["one two", "three"]);
  expect(wrap("a\nb", 10)).toEqual(["a", "b"]);
});

test("scrolling a document stops at the last screenful", () => {
  // Otherwise `end` parks the offset past the end and the next thirty presses
  // of ↑ do nothing anyone can see.
  expect(clampScroll(500, 100, 20)).toBe(80);
  expect(clampScroll(-3, 100, 20)).toBe(0);
  expect(clampScroll(5, 10, 20)).toBe(0);
});

test("a viewport pins its header and scrolls only the body", () => {
  const body = ["a", "b", "c", "d", "e"];
  expect(viewport(["head"], body, 3, 0)).toEqual(["head", "a", "b"]);
  expect(viewport(["head"], body, 3, 2)).toEqual(["head", "c", "d"]);
  expect(viewport(["head"], body, 3, 99)).toEqual(["head", "d", "e"]);
});

test("the section strip and the position label say where you are", () => {
  expect(tabs([{ label: "overview" }, { label: "KDI", count: 3 }], 1, 40)).toContain("[ KDI 3 ]");
  expect(position(0, 10, 8)).toBe("8 line(s) ");
  expect(position(20, 10, 100)).toBe("21\u201330 of 100 ");
});
