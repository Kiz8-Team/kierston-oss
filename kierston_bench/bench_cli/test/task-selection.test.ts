import { expect, test } from "bun:test";
import { familyLabel, loadFamilyChoices, selectedTaskCount, selectedTaskIds, selectionSummary, setAllCopies } from "../src/task-selection.ts";

test("series tasks are grouped into selectable families in file order", async () => {
  const file = `${import.meta.dir}/family-selection.json`;
  await Bun.write(file, JSON.stringify({
    series: {},
    outcomes: [],
    tasks: [
      { id: "alpha:1", family: "alpha" },
      { id: "beta:1", family: "beta" },
      { id: "alpha:2", family: "alpha" },
    ],
  }));
  try {
    const choices = await loadFamilyChoices(file);
    expect(choices).toEqual([
      { family: "alpha", group: "", taskIds: ["alpha:1", "alpha:2"], copies: 2 },
      { family: "beta", group: "", taskIds: ["beta:1"], copies: 1 },
    ]);
  } finally {
    await Bun.file(file).delete();
  }
});

test("known families carry their task group: technical tasks, then real-time investigations, then deception tasks", async () => {
  const file = `${import.meta.dir}/family-groups.json`;
  await Bun.write(file, JSON.stringify({
    series: {},
    outcomes: [],
    tasks: [
      { id: "swatting:1", family: "swatting" },
      { id: "protest-members:1", family: "protest-members" },
      { id: "device-to-person:1", family: "device-to-person" },
      { id: "retired:1", family: "vehicle-to-owner" },
    ],
  }));
  try {
    const choices = await loadFamilyChoices(file);
    expect(choices.map((choice) => [choice.family, choice.group])).toEqual([
      ["device-to-person", "TT"],
      ["protest-members", "RTI"],
      ["swatting", "DT"],
      ["vehicle-to-owner", ""],
    ]);
  } finally {
    await Bun.file(file).delete();
  }
});

test("copy counts resolve to concrete existing task ids", () => {
  const choices = [
    { family: "alpha", group: "", taskIds: ["alpha:1", "alpha:2", "alpha:3"], copies: 2 },
    { family: "beta", group: "", taskIds: ["beta:1"], copies: 0 },
  ];
  expect(selectedTaskIds(choices)).toEqual(["alpha:1", "alpha:2"]);
  expect(selectedTaskCount(choices)).toBe(2);
  expect(selectionSummary(choices)).toBe("2 tasks from 1 family");
  expect(familyLabel("person-reid")).toBe("Person ReID");
  expect(familyLabel("home-id")).toBe("Home ID");
});

test("one number sets every family, and short families take all they have", () => {
  const choices = [
    { family: "alpha", group: "", taskIds: ["alpha:1", "alpha:2", "alpha:3"], copies: 0 },
    { family: "beta", group: "", taskIds: ["beta:1"], copies: 3 },
  ];
  expect(setAllCopies(choices, 2)).toEqual({ short: 1 });
  expect(choices.map((choice) => choice.copies)).toEqual([2, 1]);
  expect(selectedTaskIds(choices)).toEqual(["alpha:1", "alpha:2", "beta:1"]);
  expect(setAllCopies(choices, 0)).toEqual({ short: 0 });
  expect(selectedTaskCount(choices)).toBe(0);
});
