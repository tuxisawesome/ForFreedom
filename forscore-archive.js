
/*
ForFreedom - A Forscore Utility for managing and extracting music libraries from Forscore
Copyright (C) 2026 Walter Brobson

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/


(function (global) {
  "use strict";

  const MAGIC = "<--4SBV03-->";
  const MAGIC_LEN = 12;
  const HEADER_LEN = 32;
  const NAME_LEN_FIELD = 16;
  const DATA_LEN_FIELD = 16;
  const DOCS_PREFIX = "{%DOCUMENTS_DIR%}/";
  const AUX_PREFIX = "{%AUX_DIR%}/";

  const utf8 = new TextDecoder("utf-8");

  async function readSlice(file, offset, length) {
    if (length === 0) return new Uint8Array(0);
    const blob = file.slice(offset, offset + length);
    const buf = await blob.arrayBuffer();
    return new Uint8Array(buf);
  }

  async function gunzip(bytes) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("This browser lacks DecompressionStream — required for gzip.");
    }
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  function decodeAscii(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function parseLengthField(bytes, offsetInRecord) {
    const text = decodeAscii(bytes).trim();
    if (!/^\d+$/.test(text)) {
      throw new Error(
        `Non-numeric length field "${text}" at record offset +${offsetInRecord}.`
      );
    }
    const n = parseInt(text, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Invalid length "${text}" at record offset +${offsetInRecord}.`);
    }
    return n;
  }

  /**
   * A loaded forScore archive. Construction is async — use the static open().
   *
   * The archive's record list is built in one pass over the file at open()
   * time; the underlying file Blob is held but payloads are read lazily.
   */
  class FourSBArchive {
    constructor(file, records) {
      this.file = file;
      this.records = records;
    }

    /** Magic string for V03 archives. */
    static get MAGIC() { return MAGIC; }

    /**
     * Index a .4sb file. Reads only headers + names — payloads are not
     * touched until getRecordBytes() / extractPDF().
     *
     * @param {Blob|File} file
     * @param {{onProgress?: (frac: number) => void}} [opts]
     * @returns {Promise<FourSBArchive>}
     */
    static async open(file, { onProgress } = {}) {
      const fileSize = file.size;
      if (fileSize < MAGIC_LEN) {
        throw new Error(`File too small (${fileSize} bytes) — not a forScore archive.`);
      }
      const magicBytes = await readSlice(file, 0, MAGIC_LEN);
      const magic = utf8.decode(magicBytes);
      if (magic !== MAGIC) {
        if (magic.startsWith("<--4SBV") && magic.endsWith("-->")) {
          throw new Error(
            `Unsupported forScore archive version "${magic}". This library handles "${MAGIC}".`
          );
        }
        throw new Error(
          `Not a forScore archive — magic was "${magic.replace(/[^\x20-\x7e]/g, "?")}".`
        );
      }

      const records = [];
      let offset = MAGIC_LEN;
      while (offset < fileSize) {
        if (offset + HEADER_LEN > fileSize) {
          throw new Error(`Truncated record header at offset ${offset}.`);
        }
        const header = await readSlice(file, offset, HEADER_LEN);
        const nameLen = parseLengthField(header.subarray(0, NAME_LEN_FIELD), 0);
        const dataLen = parseLengthField(
          header.subarray(NAME_LEN_FIELD, NAME_LEN_FIELD + DATA_LEN_FIELD),
          NAME_LEN_FIELD
        );
        const nameOffset = offset + HEADER_LEN;
        const dataOffset = nameOffset + nameLen;
        if (dataOffset + dataLen > fileSize) {
          throw new Error(
            `Record at offset ${offset} (name+data = ${nameLen}+${dataLen}) extends past EOF.`
          );
        }
        const nameBytes = await readSlice(file, nameOffset, nameLen);
        const name = utf8.decode(nameBytes);
        records.push({
          name,
          nameLength: nameLen,
          headerOffset: offset,
          dataOffset,
          dataLength: dataLen,
        });
        offset = dataOffset + dataLen;
        if (onProgress) onProgress(offset / fileSize);
      }
      if (offset !== fileSize) {
        throw new Error(`Trailing ${fileSize - offset} bytes after last record.`);
      }
      return new FourSBArchive(file, records);
    }

    /** First record — the manifest binary plist. */
    get manifestRecord() {
      return this.records[0] || null;
    }

    /** Read a record's payload, decompressed. */
    async getRecordBytes(record) {
      const compressed = await readSlice(this.file, record.dataOffset, record.dataLength);
      return await gunzip(compressed);
    }

    /** All score PDF records. */
    pdfRecords() {
      return this.records.filter(
        (r) => r.name.startsWith(DOCS_PREFIX) && r.name.toLowerCase().endsWith(".pdf")
      );
    }

    /** All aux records (annotations, page rasters, etc). */
    auxRecords() {
      return this.records.filter((r) => r.name.startsWith(AUX_PREFIX));
    }

    /** Extract just the filename portion of a PDF record's name. */
    pdfFilename(record) {
      if (!record.name.startsWith(DOCS_PREFIX)) return null;
      return record.name.slice(DOCS_PREFIX.length);
    }

    /**
     * Parse an aux record name into { pdfFilename, page, ext }.
     * Returns null if the name is not in {%AUX_DIR%}/<pdf>|<page>.<ext> form.
     */
    parseAuxName(name) {
      if (!name.startsWith(AUX_PREFIX)) return null;
      const tail = name.slice(AUX_PREFIX.length);
      const pipe = tail.lastIndexOf("|");
      if (pipe < 0) return null;
      const pdfFilename = tail.slice(0, pipe);
      const rest = tail.slice(pipe + 1);
      const dot = rest.lastIndexOf(".");
      if (dot < 0) return null;
      const pageStr = rest.slice(0, dot);
      const ext = rest.slice(dot + 1).toLowerCase();
      const page = parseInt(pageStr, 10);
      if (!/^\d+$/.test(pageStr) || !Number.isFinite(page)) return null;
      return { pdfFilename, page, ext };
    }

    /**
     * Aux records for a given score, filtered by extension.
     * Returned items are { record, pdfFilename, page, ext }, sorted by page.
     */
    annotationRecordsFor(pdfFilename, { ext = "png" } = {}) {
      const wantedExt = ext.toLowerCase();
      const prefix = AUX_PREFIX + pdfFilename + "|";
      const out = [];
      for (const r of this.records) {
        if (!r.name.startsWith(prefix)) continue;
        const parsed = this.parseAuxName(r.name);
        if (!parsed) continue;
        if (parsed.ext !== wantedExt) continue;
        out.push({ record: r, ...parsed });
      }
      out.sort((a, b) => a.page - b.page);
      return out;
    }

    /**
     * Summary counts useful for UIs.
     */
    summary() {
      const pdfs = this.pdfRecords();
      const aux = this.auxRecords();
      let pngs = 0, ses = 0, other = 0;
      for (const r of aux) {
        const p = this.parseAuxName(r.name);
        if (!p) { other++; continue; }
        if (p.ext === "png") pngs++;
        else if (p.ext === "4se") ses++;
        else other++;
      }
      return {
        totalRecords: this.records.length,
        pdfCount: pdfs.length,
        auxCount: aux.length,
        annotationPngCount: pngs,
        annotation4seCount: ses,
        otherAuxCount: other,
      };
    }

    /**
     * Extract a single score's PDF.
     *
     * @param {object} record - one of pdfRecords()
     * @param {object} [options]
     * @param {boolean} [options.withAnnotations=false] - bake PNG overlays into pages
     * @param {object}  [options.PDFLib] - the pdf-lib library/global; required if withAnnotations
     * @param {(phase: string, current: number, total: number) => void} [options.onProgress]
     * @returns {Promise<Uint8Array>}
     */
    async extractPDF(record, options = {}) {
      const { withAnnotations = false, PDFLib = null, onProgress = null } = options;
      const pdfBytes = await this.getRecordBytes(record);
      if (!withAnnotations) return pdfBytes;
      if (!PDFLib || !PDFLib.PDFDocument) {
        throw new Error(
          "PDFLib (pdf-lib) must be supplied to bake annotations. Pass { PDFLib: window.PDFLib }."
        );
      }
      const filename = this.pdfFilename(record);
      const annos = this.annotationRecordsFor(filename, { ext: "png" });
      if (annos.length === 0) return pdfBytes;

      const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes, { updateMetadata: false });
      const total = annos.length;
      let i = 0;
      const pageCount = pdfDoc.getPageCount();
      for (const anno of annos) {
        if (onProgress) onProgress("annotate", i, total);
        const pageIndex = anno.page - 1;
        if (pageIndex >= 0 && pageIndex < pageCount) {
          const pngBytes = await this.getRecordBytes(anno.record);
          const png = await pdfDoc.embedPng(pngBytes);
          const page = pdfDoc.getPage(pageIndex);
          const { width, height } = page.getSize();
          page.drawImage(png, { x: 0, y: 0, width, height });
        }
        i++;
      }
      if (onProgress) onProgress("annotate", total, total);
      return await pdfDoc.save({ useObjectStreams: false });
    }
  }

  global.FourSBArchive = FourSBArchive;
})(typeof window !== "undefined" ? window : globalThis);
