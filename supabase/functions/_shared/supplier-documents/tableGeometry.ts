import type { OcrDocument, OcrTable, SupplierProfileRules } from './core.ts'

function bounds(polygon?: number[]) {
  if (!polygon || polygon.length < 8) return null
  const xs = polygon.filter((_, i) => i % 2 === 0)
  const ys = polygon.filter((_, i) => i % 2 === 1)
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
}

// Rebuild only merged tables, using header anchors and original word geometry.
// Never split a product string on a trailing number or alter the stored OCR.
export function reconstructMergedTables(ocr: OcrDocument, rules: SupplierProfileRules,
  distance: (value: string, alias: string) => number): OcrDocument {
  return { ...ocr, pages: ocr.pages.map((page) => ({ ...page, tables: page.tables.map((table): OcrTable => {
    if (table.columnCount >= rules.columns.length && !table.cells.some((cell) => cell.columnSpan > 1)) return table
    const words = page.words.flatMap((word) => {
      const box = bounds(word.polygon)
      return box ? [{ text: word.text, ...box, x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 }] : []
    })
    if (!words.length) return table
    const rows = Array.from({ length: table.rowCount }, (_, rowIndex) => {
      const boxes = table.cells.filter((cell) => cell.rowIndex === rowIndex).flatMap((cell) => {
        const box = bounds(cell.polygon)
        return box ? [box] : []
      })
      return words.filter((word) => boxes.some((box) => word.x >= box.left && word.x <= box.right
        && word.y >= box.top && word.y <= box.bottom)).sort((a, b) => a.left - b.left)
    })
    for (let headerIndex = 0; headerIndex < rows.length; headerIndex++) {
      const header = rows[headerIndex]
      const anchors = rules.columns.flatMap((column) => {
        const candidates: Array<{ left: number; right: number; height: number; alias: string; score: number; width: number }> = []
        for (let start = 0; start < header.length; start++) {
          for (let end = start; end < Math.min(header.length, start + 8); end++) {
            const span = header.slice(start, end + 1)
            const text = span.map((word) => word.text).join(' ')
            for (const alias of column.headerAliases) {
              const score = distance(text, alias)
              if (Number.isFinite(score)) candidates.push({ left: header[start].left, right: header[end].right,
                height: Math.max(...span.map((word) => word.bottom - word.top)), alias, score, width: end - start })
            }
          }
        }
        candidates.sort((a, b) => a.score - b.score || a.width - b.width)
        const best = candidates[0]
        if (!best || candidates.some((candidate) => candidate.score === best.score && candidate.width === best.width
          && candidate.left !== best.left)) return []
        return [{ ...best, field: column.field }]
      })
      const required = new Set([...rules.columns.filter((column) => column.required).map((column) => column.field), 'unitPrice', 'lineTotal'])
      if (![...required].every((field) => anchors.some((anchor) => anchor.field === field))) continue
      anchors.sort((a, b) => a.left - b.left)
      if (anchors.some((anchor, index) => index > 0 && anchor.left <= anchors[index - 1].right)) continue
      const cuts = anchors.map((anchor) => anchor.left - anchor.height)
      const followingRows = rows.slice(headerIndex + 1)
      const end = rules.tableEndText ? followingRows.findIndex((row) => distance(row.map((word) => word.text).join(' '), rules.tableEndText!) === 0) : -1
      const data = end < 0 ? followingRows : followingRows.slice(0, end)
      const matrix = [anchors.map((anchor) => anchor.alias), ...data.map((row) => anchors.map((_, index) =>
        row.filter((word) => word.x >= cuts[index] && (index === cuts.length - 1 || word.x < cuts[index + 1]))
          .map((word) => word.text).join(' ')))]
      return { rowCount: matrix.length, columnCount: anchors.length,
        cells: matrix.flatMap((row, rowIndex) => row.map((text, columnIndex) => ({
          rowIndex, columnIndex, rowSpan: 1, columnSpan: 1, text,
        }))) }
    }
    return table
  }) })) }
}
