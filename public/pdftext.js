/* The text of a PDF, in the browser. Nothing leaves the browser.
 * Uses pdf.js 1.10.100 and joins the pieces exactly like the Node reader (pdf-parse) that the invoice
 * readers were built on: same line -> joined as is, lower down -> new line. A newer pdf.js spaces the
 * pieces differently, which the readers would not recognise. */
const PdfText = (() => {
  const BASE = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/1.10.100/";
  let ready = null;
  function load() {
    ready = ready || new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = BASE + "pdf.min.js";
      s.onload = () => { window.PDFJS.workerSrc = BASE + "pdf.worker.min.js"; ok(window.PDFJS); };
      s.onerror = () => { ready = null; fail(new Error("Couldn't load the PDF reader. Check your connection.")); };
      document.head.appendChild(s);
    });
    return ready;
  }
  async function read(file) {
    const PDFJS = await load();
    const doc = await PDFJS.getDocument(new Uint8Array(await file.arrayBuffer()));
    let all = "";
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      let lastY, text = "";
      for (const item of content.items) {
        text += lastY == item.transform[5] || !lastY ? item.str : "\n" + item.str;
        lastY = item.transform[5];
      }
      all += "\n\n" + text;
    }
    return all;
  }
  return { read };
})();
