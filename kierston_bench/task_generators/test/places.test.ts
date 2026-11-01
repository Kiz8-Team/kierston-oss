import { expect, test } from "bun:test";
import { PlaceBook } from "../src/places.ts";

const book = new PlaceBook();
// One church, on the map as a node and in the register under its own id.
book.add({ id: "v:node/10", name: "Grace Church", lat: 40.6, lon: -75.47, address: "12 Elm Street, Allentown, PA 18102" });
book.add({ id: "w:poi/grace_church", name: "Grace Church", lat: 40.6001, lon: -75.4701 });
// Two branches of one chain, a mile apart.
book.add({ id: "w:way/3", name: "Dollar General", address: "Union Boulevard, Allentown, PA 18109", lat: 40.62, lon: -75.44 });
book.add({ id: "w:way/4", name: "Dollar General", address: "Hanover Avenue, Allentown, PA 18109", lat: 40.61, lon: -75.45 });

test("a place recorded twice under one name is one place", () => {
  expect(book.resolve("Grace Church").ids).toEqual(["node/10"]);
  expect(book.resolve("poi/grace_church").ids).toEqual(["node/10"]);
  expect(book.same("w:poi/grace_church")).toBe("node/10");
});

test("the twin's address is the place's address", () => {
  expect(book.textOf("poi/grace_church")).toEqual({ name: "Grace Church", address: "12 Elm Street, Allentown, PA 18102" });
});

test("branches of a chain stay apart until an address picks one", () => {
  expect(book.resolve("Dollar General").ids).toEqual(["way/3", "way/4"]);
  expect(book.resolve("Dollar General, Hanover Avenue, Allentown, PA 18109")).toEqual({ ids: ["way/4"], via: "name+address" });
});
