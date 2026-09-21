export const WORKBOOK_CONTRACT = {
  version: 2,
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  filename: 'mapatz-inventory.xlsx',
  sheets: {
    resetLocations: {
      name: 'Reset Locations',
      columns: ['Name', 'Archived'],
    },
    resetItems: {
      name: 'Reset Items',
      columns: [
        'Item Code',
        'Name',
        'Kind',
        'Location',
        'Aliases',
        'Lot Size',
        'Archived',
        'Total',
      ],
    },
    recoveryLocations: {
      name: 'Recovery Locations',
      columns: ['Name', 'Archived'],
    },
    recoveryItems: {
      name: 'Recovery Items',
      columns: [
        'Item Code',
        'Name',
        'Kind',
        'Location',
        'Aliases',
        'Lot Size',
        'Archived',
        'Created At',
        'Starting Stock',
        'Baseline Through Event ID',
      ],
    },
    recoveryBorrowers: {
      name: 'Recovery Borrowers',
      columns: ['Username', 'Name', 'Contact', 'Type', 'Archived', 'Created At'],
    },
    recoveryEvents: {
      name: 'Recovery Events',
      columns: [
        'Event ID',
        'Kind',
        'Item Code',
        'Borrower Username',
        'Quantity',
        'Related Event ID',
        'Note',
        'Created At',
      ],
    },
    unresolvedDamage: {
      name: 'Unresolved Damage',
      columns: ['Item Code', 'Item Name', 'Location', 'Unresolved Damaged Quantity'],
    },
    consumablesUsage: {
      name: 'Consumables Usage',
      columns: [
        'Item Code',
        'Item Name',
        'Location',
        'Start of Cycle Stock',
        'Added During Cycle',
        'Usage',
        'Left',
      ],
    },
  },
} as const;

export type WorkbookSheetKey = keyof typeof WORKBOOK_CONTRACT.sheets;
