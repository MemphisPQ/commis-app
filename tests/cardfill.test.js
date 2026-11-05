const test = require("node:test");
const assert = require("node:assert/strict");
const CardFill = require("../public/cardfill.js");

// The shape of the "AA Recipe Template": title with “O”, Ready in + bold value, Yield:, then three headed sections.
const P = (inner, ppr = "") => `<w:p w14:paraId="0000000${Math.floor(Math.random() * 9)}"><w:pPr>${ppr}</w:pPr>${inner}</w:p>`;
const R = (t, rpr = "") => `<w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
const LIST = (id) => `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${id}"/></w:numPr>`;
const H = (t) => P(R(t), `<w:pStyle w:val="Heading1"/>`);
const TEMPLATE = `<?xml version="1.0"?><w:document xmlns:w="w" xmlns:w14="w14"><w:body>` +
  P(R("RECIPE", "<w:color w:val=\"666666\"/>") + `<w:r><w:br w:type="textWrapping"/><w:t xml:space="preserve">“O”</w:t></w:r>`, `<w:pStyle w:val="Title"/>`) +
  P(R("(O)")) + P(R("Ready in ") + R("4.5 - 12 hrs", "<w:b w:val=\"1\"/>")) + P(R("Yield:")) + P(`<w:r><w:br w:type="column"/></w:r>`) +
  H("Ingredients") + P(R("8"), LIST(1)) + H("Preparation") + P(R("S"), LIST(2)) + H("Notes") + P(R("D")) +
  `<w:sectPr><w:cols w:num="2"/></w:sectPr></w:body></w:document>`;

const texts = (xml) => CardFill.pieces(xml.split("<w:body>")[1].split("</w:body>")[0]).filter((x) => x.name === "w:p").map((x) => x.text);

test("a card fills the template's own places and keeps the rest", () => {
  const out = CardFill.fillXml(TEMPLATE, { name: "Chicken Brine", readyIn: "6hr", yieldText: "1 Portion / 30 kg",
    ingredients: ["2.45kg Salt", "150g Black Peppercorns"], steps: ["Boil.", "Chill & store <cold>."], notes: [] });
  assert.deepEqual(texts(out), ["RECIPE“Chicken Brine”", "(O)", "Ready in 6hr", "Yield: 1 Portion / 30 kg", "", "Ingredients",
    "2.45kg Salt", "150g Black Peppercorns", "Preparation", "Boil.", "Chill & store <cold>.", "Notes", ""]);
  assert.match(out, /<w:b w:val="1"\/><\/w:rPr><w:t xml:space="preserve">6hr</); // the value keeps the template's bold
  assert.equal((out.match(/<w:numId w:val="1"\/>/g) || []).length, 2);  // each ingredient in the numbered list
  assert.equal((out.match(/<w:numId w:val="2"\/>/g) || []).length, 2);
  assert.match(out, /Chill &amp; store &lt;cold&gt;\./);
  assert.match(out, /<w:sectPr><w:cols w:num="2"\/><\/w:sectPr><\/w:body>/);   // two columns, untouched
  assert.match(out, /<w:color w:val="666666"\/>/);
  assert.ok(!/paraId="[^"]*"[\s\S]*Black Peppercorns/.test(out.split("2.45kg Salt")[1] || "")); // copies get no duplicate ids
});
