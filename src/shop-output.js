import { formatLength } from './units.js';

const instanceKey = (partId, n) => `${partId}\u0000${n}`;

/**
 * Build one shop-floor record for every physical part in the current plan.
 * Keeping this DOM-free makes labels and exports agree, and makes the export
 * rules straightforward to test.
 */
export function buildShopRows(projectName, units, parts, plan, letterFor) {
  const placements = new Map();
  for (const sheet of plan.sheets) {
    for (const placement of sheet.placements) {
      placements.set(instanceKey(placement.partId, placement.n), { sheet, placement });
    }
  }

  const unplaced = new Map(plan.unplaced.map((item) => [item.partId, item.reason]));
  const rows = [];
  parts.forEach((part, partIndex) => {
    for (let instance = 1; instance <= part.qty; instance++) {
      const found = placements.get(instanceKey(part.id, instance));
      const reason = found ? '' : unplaced.get(part.id) || 'no-stock';
      const status = found ? 'Placed'
        : reason === 'too-big' ? 'Unplaced: too large'
          : reason === 'wrong-thickness' ? 'Unplaced: no matching thickness'
            : 'Unplaced: not enough stock';
      const cutLength = found?.placement.cutLength ?? part.length + (part.lengthAllowance ?? 0);
      const cutWidth = found?.placement.cutWidth ?? part.width + (part.widthAllowance ?? 0);
      rows.push({
        project: projectName || 'Untitled project',
        partId: part.id,
        letter: letterFor(partIndex),
        name: part.name,
        instance,
        quantity: part.qty,
        length: part.length,
        width: part.width,
        cutLength,
        cutWidth,
        lengthAllowance: part.lengthAllowance ?? 0,
        widthAllowance: part.widthAllowance ?? 0,
        thickness: part.thickness ?? '',
        edgeBand: part.edgeBand || 'none',
        units,
        grain: part.grain ? 'Along length' : 'Can be turned',
        status,
        sheet: found ? found.sheet.index + 1 : '',
        stock: found ? found.sheet.stockName : '',
        stockCopy: found ? found.sheet.copy : '',
        x: found ? found.placement.x : '',
        y: found ? found.placement.y : '',
        rotated: found ? found.placement.rotated : '',
      });
    }
  });
  return rows;
}

function csvCell(value) {
  let text = String(value ?? '');
  // Prevent project/part names from being interpreted as formulas by common
  // spreadsheet programs while preserving the visible value.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function shopRowsToCsv(rows) {
  const columns = [
    ['Project', (r) => r.project],
    ['Part', (r) => r.letter],
    ['Name', (r) => r.name],
    ['Instance', (r) => r.instance],
    ['Quantity', (r) => r.quantity],
    ['Finished length', (r) => formatLength(r.length, r.units)],
    ['Finished width', (r) => formatLength(r.width, r.units)],
    ['Cut length', (r) => formatLength(r.cutLength, r.units)],
    ['Cut width', (r) => formatLength(r.cutWidth, r.units)],
    ['Thickness', (r) => r.thickness === '' ? '' : formatLength(r.thickness, r.units)],
    ['Extra length', (r) => formatLength(r.lengthAllowance, r.units)],
    ['Extra width', (r) => formatLength(r.widthAllowance, r.units)],
    ['Edge banding', (r) => r.edgeBand],
    ['Units', (r) => r.units === 'mm' ? 'mm' : 'in'],
    ['Grain direction', (r) => r.grain],
    ['Status', (r) => r.status],
    ['Sheet', (r) => r.sheet],
    ['Stock', (r) => r.stock],
    ['Stock copy', (r) => r.stockCopy],
    ['X from left', (r) => r.x === '' ? '' : formatLength(r.x, r.units)],
    ['Y from top', (r) => r.y === '' ? '' : formatLength(r.y, r.units)],
    ['Rotated', (r) => r.rotated === '' ? '' : r.rotated ? 'Yes' : 'No'],
  ];
  return [
    columns.map(([heading]) => csvCell(heading)).join(','),
    ...rows.map((row) => columns.map(([, get]) => csvCell(get(row))).join(',')),
  ].join('\r\n');
}
