# forScore `.4sb` Backup Archive Format (Version 03)

This document describes the on-disk format of a forScore archive (`.4sb`) file,
reverse-engineered from `Archive 2026-04-25 14-20-24.4sb` (1,169,431,595 bytes,
90 records). It targets format version `03` (current as of forScore 2026).

A `.4sb` is a flat, self-describing concatenation of length-prefixed records.
There is no central index, no chunk table, no checksum, and no per-record
metadata block — the consumer streams from byte 0 to EOF, decoding records
sequentially.

---

## 1. File layout (top level)

```
+-----------------------------+
| Magic                       |  12 bytes
+-----------------------------+
| Record 0 (manifest plist)   |  variable
+-----------------------------+
| Record 1 (e.g. PDF)         |  variable
+-----------------------------+
| Record 2 ...                |
+-----------------------------+
| ...                         |
+-----------------------------+
| Record N-1 (last)           |
+-----------------------------+
```

The file ends exactly at the end of the last record — no trailer, no padding.

In the analyzed sample, magic + record framing overhead totals 6,652 bytes
(0.0006%); the remainder (1,169,424,943 bytes) is gzip‑compressed payload.

---

## 2. Magic header

The file begins with the 12 ASCII bytes:

```
<--4SBV03-->
```

| Offset | Length | Bytes (hex)                                 | Meaning                |
| ------ | ------ | ------------------------------------------- | ---------------------- |
| `0x00` | 12     | `3C 2D 2D 34 53 42 56 30 33 2D 2D 3E`       | Literal `<--4SBV03-->` |

The trailing `03` is the **format version**. Older archives are presumably
`<--4SBV01-->` / `<--4SBV02-->`; new readers should reject anything that does
not start with `<--4SBV` and end the magic with `-->`.

There is no byte-order mark; all numeric fields in the framing layer are ASCII
text.

---

## 3. Record framing

Immediately after the magic, the file is a stream of records. Each record has
a fixed 32-byte header followed by a variable-length name and payload:

```
offset  size  field
------  ----  -----------------------------------------------------------------
  0     16    ASCII decimal name length, right-aligned, space-padded ('  ...31')
 16     16    ASCII decimal data length, right-aligned, space-padded
 32     N     UTF-8 record name (N = name length from header)
 32+N   M     Compressed payload (M = data length from header)
```

### 3.1 The two length fields

Both length fields are **16 bytes of ASCII**, not binary integers. The decimal
number is right-justified within the 16-byte field and padded with U+0020
spaces on the left. Example bytes for a 31-byte name:

```
20 20 20 20 20 20 20 20 20 20 20 20 20 20 33 31    "              31"
```

Parsing rule: read 16 bytes, decode as ASCII, strip whitespace, parse as a
base-10 integer. A leading `+`, a sign, or non-digit characters other than
spaces are not expected and should be treated as a corrupt archive.

The name length appears first; the data length appears second. The maximum
representable length is therefore `9999999999999999` (~10^16 − 1) bytes, which
is far above any practical limit.

### 3.2 Record name

The name is `name_length` bytes of UTF-8 text. It is **not** null-terminated
and **not** length-prefixed in any other way. Names contain forward slashes
and may include any UTF‑8 character that is legal in the originating
filesystem (the sample includes Chinese characters, e.g. `成都.pdf`).

Names use a small set of leading **path placeholder tokens** (see §4) that the
importer expands at restore time.

### 3.3 Record payload

The payload is `data_length` bytes of **gzip-compressed data** (RFC 1952).
Every record's payload in the sample begins with the gzip magic
`1F 8B 08 00`. Readers should:

1. Read exactly `data_length` bytes.
2. Decompress with a streaming gunzip.
3. Interpret the result based on the record's name (its extension and path
   placeholder).

The data length is the **compressed** length on disk, not the uncompressed
size. The original size is recoverable from the gzip footer (`ISIZE mod 2^32`)
or by completing the decompression stream.

### 3.4 End of file

After processing record `N-1`, the file cursor must equal the file size.
Any trailing bytes indicate corruption.

---

## 4. Path placeholder tokens

Record names use two tokens that the importer rewrites to absolute paths
inside forScore's app sandbox at restore time:

| Token              | Maps to (logically)                                                                 |
| ------------------ | ------------------------------------------------------------------------------------ |
| `{%DOCUMENTS_DIR%}` | The app's user-visible Documents folder, where score PDFs live.                     |
| `{%AUX_DIR%}`       | The app's auxiliary folder, where per-page annotations and rasterized layers live. |

The placeholder is always followed by `/` and then a relative path. Examples:

```
{%DOCUMENTS_DIR%}/Greensleeves.Pdf
{%DOCUMENTS_DIR%}/成都.pdf
{%AUX_DIR%}/Paganini Etudes.pdf|38.png
{%AUX_DIR%}/Flute Sonata BWV 1034.pdf|1.4se
```

Note that aux file names embed a `|` (U+007C) between the source PDF's
filename and a per-page identifier. The pipe is **not** a path separator — it
is a literal character within a single filename. This pairs each annotation
artifact with its parent score and a 1-based page number.

---

## 5. Record taxonomy

In the analyzed archive (90 records total), every record falls into exactly
one of four categories, identified by its name:

| Category               | Name pattern                                       | Count | Decoded payload                       |
| ---------------------- | -------------------------------------------------- | ----- | ------------------------------------- |
| Manifest (always #0)   | `<archive-filename>.4sb`                          | 1     | Apple binary property list           |
| Score PDF              | `{%DOCUMENTS_DIR%}/<name>.pdf`                    | 43    | Standard PDF document                 |
| Page annotation raster | `{%AUX_DIR%}/<name>.pdf\|<page>.png`              | 41    | PNG image (RGBA, page-resolution)     |
| Page annotation vector | `{%AUX_DIR%}/<name>.pdf\|<page>.4se`              | 5     | Gzip-wrapped binary plist (`forScore Edit`) |

Order is **manifest first**, followed by the documents and aux files. Within
documents/aux there is no enforced order in the sample (PDFs interleave with
each other and aux files appear at the end).

### 5.1 Manifest record (record 0)

* **Name** — equal to the archive's own filename, e.g.
  `Archive 2026-04-25 14-20-24.4sb`. This is how a reader recognizes record 0
  as the manifest without needing a separate flag.
* **Payload** — gzip → Apple binary property list (bplist00) at the top, with
  a single root `<dict>`.

Top-level keys observed:

| Key prefix / name        | Type   | Purpose                                                          |
| ------------------------ | ------ | ---------------------------------------------------------------- |
| `&SYS;<setting>`         | mixed  | Global app preferences (one entry per setting).                  |
| `<filename.pdf>\|<attr>` | mixed  | Per-score metadata (one entry per `(score, attribute)` pair).    |
| `stamps.plist`           | array  | Legacy custom stamp images (base64 PNGs).                        |
| `stamps2.plist`          | array  | Newer stamp definitions (`NSKeyedArchiver` blobs, SF Symbols).   |

#### 5.1.1 `&SYS;` — system/app settings

Each `&SYS;` key holds one user preference. Examples observed:

| Key                              | Type    | Notes                                            |
| -------------------------------- | ------- | ------------------------------------------------ |
| `&SYS;ARCurrentVersion`          | string  | App version that wrote the archive.              |
| `&SYS;ARFirstUseDate`            | real    | NSDate-style epoch.                              |
| `&SYS;ARUseCount`                | int     | Launches.                                        |
| `&SYS;analyticsEnabled`          | bool    |                                                  |
| `&SYS;autoturnMode`              | bool    | Auto page-turn on/off.                           |
| `&SYS;blockFingerInput`          | bool    | Pencil-only drawing.                             |
| `&SYS;cornerTap`                 | bool    | Corner-tap navigation.                           |
| `&SYS;currentBrush`              | int     | Last-selected pen tool ID (negative = builtin).  |
| `&SYS;currentStampID`            | string  | UUID of the last-used stamp.                     |
| `&SYS;darkPageStyle`             | bool    | Dark-mode page rendering.                        |
| `&SYS;edgeSwipes`                | bool    |                                                  |
| `&SYS;globalTint`                | data    | Archived `UIColor` (light mode).                 |
| `&SYS;globalTintDarkMode`        | data    | Archived `UIColor` (dark mode).                  |
| `&SYS;lastCurrentFilePath`       | string  | Score open at backup time.                       |
| `&SYS;lastSpotlightRebuild`      | date    | Last metadata-index rebuild timestamp.           |
| `&SYS;pageTransition`            | int     | Page-curl / slide / none.                        |
| `&SYS;penPresets`                | array   | Strings of the form `H\|S\|B\|A\|X\|width`, plus  |
|                                  |         | special tokens `Stamps\|<size>` and `Shapes\|<size>`. |
| `&SYS;recentFilters`             | array   | Most-recent library filter dicts.                |
| `&SYS;recentTools`               | array   | Recently-used tool indices.                      |
| `&SYS;setlists`                  | array   | User setlists.                                   |
| `&SYS;setlistFolders`            | array   | Setlist folder structure.                        |
| `&SYS;setlistLibraries`          | dict    | Library bindings for setlists.                   |
| `&SYS;shape4`                    | data    | Archived custom shape preset.                    |

Many `&SYS;` keys are version-gated upgrade flags (`tenThreeUpgrade`,
`thirteenTwoUpgrade`, `thirteenFourFix`, `stampsSevenUpgrade`,
`stampsNineUpgrade`) — the app sets them once and they remain `true` forever.
A reader importing an archive should preserve these verbatim rather than
rederiving them.

The `&` is not an entity reference inside the binary plist; the literal first
character of every such key is U+0026. (When converted to XML via `plutil`,
it becomes `&amp;`.)

#### 5.1.2 `<filename>|<attr>` — per-score metadata

Per-PDF entries use the score's filename (with extension) as a namespace,
followed by `|` (U+007C) and an attribute name. Attributes observed:

| Attribute    | Type    | Description                                                                  |
| ------------ | ------- | ---------------------------------------------------------------------------- |
| `added`      | date    | Import timestamp.                                                            |
| `bpm`        | int     | Tempo in beats per minute.                                                   |
| `bookmarks`  | array   | Array of bookmark dicts (see §5.1.3).                                        |
| `composer`   | string  |                                                                              |
| `key`        | int     | Key/scale code.                                                              |
| `keywords`   | string  | Comma-separated.                                                             |
| `labels`     | string  | Comma-separated category labels (e.g. `"Piano Academy"`, `"Auditions"`).     |
| `pitch`      | int     | Reference pitch / transposition.                                             |
| `title`      | string  | Display title (independent of filename).                                     |
| `zoom`       | real    | Persisted zoom factor.                                                       |

The score's filename inside the namespace (`Piano Sonata KV 281.pdf|added`)
matches exactly the filename inside `{%DOCUMENTS_DIR%}/...` for that score's
PDF record. Filename casing is preserved (note `Greensleeves.Pdf` vs
`Greensleeves.pdf` — the sample uses both, suggesting forScore stores the
filename as recorded by the OS at import).

#### 5.1.3 Bookmark dict shape

Each entry inside a `bookmarks` array is a dict. Observed keys:

| Key                       | Type    | Description                                                        |
| ------------------------- | ------- | ------------------------------------------------------------------ |
| `Title`                   | string  | Bookmark display title (e.g. movement name).                       |
| `Composer`                | string  | Often duplicates the parent score's composer.                      |
| `FilePath`                | string  | Filename of the parent PDF (no placeholder, no `{%DOCUMENTS_DIR%}`). |
| `First Page`              | int     | 1-based first page of the bookmark range.                          |
| `Last Page`               | int     | 1-based last page (inclusive).                                     |
| `Identifier`              | string  | UUID, uppercase, dashed.                                           |
| `BPM`                     | string  | Tempo (note: `string` here, vs `int` at score level).              |
| `Key`                     | int     | Key code.                                                          |
| `Keyword`                 | string  | Singular form of `keywords`.                                       |
| `Label`                   | string  | Singular form of `labels`.                                         |
| `Signature`               | string  | Time signature.                                                    |
| `Categories`              | array   | Array of `{ Type: <string>, Value: <string> }` dicts.              |
| `Type` / `Value`          | string  | Used inside `Categories` items.                                    |
| `kRecoverableDestination` | int     | Internal flag (observed as `1`).                                   |

#### 5.1.4 `stamps.plist`

An array of base64-encoded PNG images (legacy stamp format from older
forScore versions). Each entry is a `<data>` blob whose decoded bytes are a
standalone PNG.

#### 5.1.5 `stamps2.plist`

An array of `<data>` blobs, but each blob is itself a serialized
`NSKeyedArchiver` graph (binary plist starting with `bplist00`). Decoded
entries observed in the sample reference SF Symbol identifiers such as
`play.circle`, `pause.circle`, `stop.circle`, `record.circle`,
`backward.circle`, `forward.circle`, `shuffle.circle`, `repeat.circle`,
`infinity.circle`, plus `.fill` variants and `play.square.stack[.fill]`.
This is forScore's modern stamp library, where stamps reference system
symbols rather than embedded PNGs.

### 5.2 Score PDF records

* **Name** — `{%DOCUMENTS_DIR%}/<filename>.pdf`. The filename matches the
  per-score namespace used in the manifest.
* **Payload** — gzip → standard PDF (`%PDF-1.x`). No forScore-specific
  modifications; the PDF is restored byte-for-byte to
  `Documents/<filename>.pdf`.

The sample contains 43 PDF records ranging from 93 KB to ~113 MB compressed.

### 5.3 PNG annotation rasters

* **Name** — `{%AUX_DIR%}/<pdf-filename>|<page>.png`, where `<page>` is a
  1-based page number.
* **Payload** — gzip → PNG, RGBA, full page resolution (e.g. 2752 × 3598
  px in the sample). The image is the rasterized **annotation overlay** for
  that page, transparent where the user did not draw. forScore composites it
  back over the underlying PDF page at display time.

A page only has a `.png` aux record if the user drew on that page.

### 5.4 4SE annotation vectors

* **Name** — `{%AUX_DIR%}/<pdf-filename>|<page>.4se`.
* **Payload** — gzip → **another gzip stream** → Apple binary property list.
  The inner plist is an `NSKeyedArchiver` graph.
* **Note the double gzip**: `.4se` is forScore's native on-disk annotation
  format and is itself gzip-compressed. The 4SB record framing wraps that
  with a second gzip layer. A reader must call gunzip twice to reach the
  plist.

The decoded plist describes the **layered annotations** for the page. Top-level
keys observed: `baseLayer`, `activeLayer`, `scoreLayers`, `layers`. Layer
dicts contain `layerID` (UUID), `name` (e.g. `"PDF"`, `"Bored"`), `number`,
`isVisible`, and `image` (an `FSTimestampedImage` referencing a `UIImage` with
`UIImageConfiguration` / `UITraitCollection`). This mirrors forScore's
multi-layer annotation model where each layer is independently toggleable.

A page may have **both** a `.png` and a `.4se` (the sample has 5 `.4se` and
the same pages also have `.png`); they represent different layer types or
different storage choices made by the app.

---

## 6. Round-trip semantics

* On **export**, forScore writes the manifest first (capturing all settings,
  metadata, bookmarks, and stamps), then walks the user's library writing
  one record per source PDF, then walks the aux folder writing one record
  per annotation file.
* On **import**, the consumer:
  1. Validates the magic.
  2. Reads record 0, decompresses, parses the bplist, and applies system
     settings + score metadata to the app's database.
  3. For each subsequent record, expands the placeholder, decompresses, and
     writes the payload to the resulting absolute path. PDFs go to
     `Documents/`, annotations to the aux folder.
* No record references another by ID — the binding is purely by filename.
  Renaming a PDF after import will orphan its aux files unless the manifest
  metadata is renamed in lockstep.

---

## 7. Quick reference: parsing pseudocode

```python
import gzip, plistlib

def read_4sb(path):
    with open(path, "rb") as f:
        magic = f.read(12)
        assert magic == b"<--4SBV03-->", "not a 4SB v03 archive"
        records = []
        while True:
            hdr = f.read(32)
            if not hdr:
                break
            assert len(hdr) == 32
            name_len = int(hdr[:16].decode("ascii").strip())
            data_len = int(hdr[16:32].decode("ascii").strip())
            name     = f.read(name_len).decode("utf-8")
            payload  = gzip.decompress(f.read(data_len))
            records.append((name, payload))
        return records

records = read_4sb("Archive 2026-04-25 14-20-24.4sb")
manifest_name, manifest_bytes = records[0]
manifest = plistlib.loads(manifest_bytes)  # bplist00 → dict
```

To resolve a `.4se` annotation file:

```python
inner = gzip.decompress(payload)         # 4SB record already decompressed once
plist = plistlib.loads(inner)             # NSKeyedArchiver graph
```

---

## 8. Format properties / invariants

* **Streamable**: producer can write records as it discovers them; consumer
  needs only forward seeks.
* **No integrity check**: there is no whole-file checksum. The only
  consistency signal is the gzip CRC inside each payload.
* **No record count**: the consumer determines completion by reaching EOF.
* **No deduplication**: identical PDFs / identical aux PNGs are stored once
  per record.
* **No encryption**: the file is plaintext-readable after decompression. Any
  passwords or rights-managed PDFs retain their original protection because
  the PDF bytes are stored verbatim.
* **Filename is the key**: the manifest, the score record, and the aux
  records all use the filename string as the join key. Filenames are
  case-preserving but case-sensitivity behavior on import depends on the
  destination filesystem.
* **UTF-8 throughout**: record names, manifest plist keys, and string values
  are UTF-8 (or NSString-equivalent inside binary plists).

---

## 9. Known unknowns

The following were observed but not exhaustively decoded:

* The exact code tables behind the integer `key` / `Key` fields (e.g. whether
  `310` and `510` map to musical-key constants).
* The full schema of `&SYS;penPresets` strings beyond the
  `H|S|B|A|X|width` / `Stamps|<n>` / `Shapes|<n>` shapes.
* Whether `&SYS;ARCurrentVersion` is the file-format version, the app
  version, or the App Review prompt version (the `AR` prefix is ambiguous).
* Whether older `<--4SBV01-->` / `<--4SBV02-->` archives use the same 32-byte
  ASCII length framing, or a different layout.
