import * as ExcelJS from 'exceljs';
import 'jdate.js';

export function formatJalaliDateTime(
  date: Date | string | null | undefined,
): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '—';

  if (typeof (d as any).jalaliSync === 'function') {
    (d as any).jalaliSync();
  }
  const j = (d as any).jalali;
  if (j && typeof j.year === 'number') {
    const month = typeof j.month === 'number' ? j.month + 1 : 1;
    const day = typeof j.date === 'number' ? j.date : 1;
    return `${j.year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  // در صورت عدم دسترسی به jalaliSync از تبدیل دستی Date.gregorianToJalali استفاده می‌شود
  if (typeof (Date as any).gregorianToJalali === 'function') {
    const gj = (Date as any).gregorianToJalali(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
    );
    const month = gj.month + 1;
    return `${gj.year}/${String(month).padStart(2, '0')}/${String(gj.date).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  const iso = d.toISOString().replace('T', ' ').substring(0, 19);
  return iso;
}

export interface ExcelColumnDefinition {
  header: string;
  key: string;
  width?: number;
}

export async function createExcelWorkbook(
  sheetName: string,
  columns: ExcelColumnDefinition[],
  rows: Record<string, any>[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SyncPage';
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet(sheetName, {
    views: [{ rightToLeft: true }],
  });

  worksheet.columns = columns.map((col) => ({
    header: col.header,
    key: col.key,
    width: col.width || 20,
    style: {
      alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
      font: { name: 'Tahoma', size: 10 },
    },
  }));

  // استایل‌دهی ردیف هدر
  const headerRow = worksheet.getRow(1);
  headerRow.height = 28;
  headerRow.font = {
    name: 'Tahoma',
    size: 11,
    bold: true,
    color: { argb: 'FFFFFFFF' },
  };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF4F46E5' }, // Accent indigo color
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  for (let i = 1; i <= columns.length; i++) {
    const cell = headerRow.getCell(i);
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF3730A3' } },
      left: { style: 'thin', color: { argb: 'FF3730A3' } },
      bottom: { style: 'medium', color: { argb: 'FF312E81' } },
      right: { style: 'thin', color: { argb: 'FF3730A3' } },
    };
  }

  // اضافه کردن ردیف‌ها
  rows.forEach((rowData, index) => {
    const row = worksheet.addRow(rowData);
    row.height = 24;
    const isEven = index % 2 === 0;
    const bgArgb = isEven ? 'FFFFFFFF' : 'FFF8FAFC';

    for (let i = 1; i <= columns.length; i++) {
      const cell = row.getCell(i);
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: bgArgb },
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      };
    }
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
