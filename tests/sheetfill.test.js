const test = require("node:test");
const assert = require("node:assert/strict");
const { Sheet } = require("../public/sheetfill.js");

const XML = `<worksheet><sheetData><row r="1"><c r="A1" s="1"/><c r="C1" s="3"><f>B1*2</f><v>0</v></c></row>` +
  `<row r="4"><c r="A4" s="13" t="s"><v>7</v></c><c r="B4" s="14"/></row></sheetData></worksheet>`;

test("cells keep the template's look, and missing ones go in the right place", () => {
  const s = new Sheet(XML);
  s.set("A1", { v: "Chicken, Roast & co" });
  s.set("B4", { v: 0.25 });
  s.keep("C1", 0.5);
  s.set("B1", { v: 3 });                        // a cell the row doesn't have yet: between A1 and C1
  s.set("A2", { f: "'Recipe 1'!$A$1", v: "Gravy" }); // a row the sheet doesn't have yet: before row 4
  assert.match(s.xml, /<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Chicken, Roast &amp; co<\/t><\/is><\/c><c r="B1"><v>3<\/v><\/c><c r="C1" s="3"><f>B1\*2<\/f><v>0.5<\/v><\/c>/);
  assert.match(s.xml, /<\/row><row r="2"><c r="A2" t="str"><f>'Recipe 1'!\$A\$1<\/f><v>Gravy<\/v><\/c><\/row><row r="4">/);
  assert.match(s.xml, /<c r="B4" s="14"><v>0.25<\/v><\/c>/);
  assert.equal(s.formula("C1"), "B1*2");
  assert.equal(s.number("B4"), 0.25);
  assert.ok(!s.find("A10"));                     // A1 isn't mistaken for A10, or the other way round
});
