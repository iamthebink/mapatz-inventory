export const WORKBOOK_CONTRACT = {
  version: 7,
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  filename: 'mapatz-inventory.xlsx',
  sheets: {
    resetLocations: {
      name: 'Reset Locations',
      columns: ['Name', 'Archived'],
    },
    resetItems: {
      name: 'Reset Items',
      columns: ['Name', 'Kind', 'Location', 'Aliases', 'Lot Size', 'Archived', 'Total'],
    },
    recoveryLocations: {
      name: 'Recovery Locations',
      columns: ['Name', 'Archived'],
    },
    recoveryItems: {
      name: 'Recovery Items',
      columns: [
        'Item ID',
        'Name',
        'Kind',
        'Location',
        'Aliases',
        'Lot Size',
        'Archived',
        'Created At',
        'Starting Stock',
        'Baseline Through Event ID',
        'Available',
        'Borrowed',
        'Damaged',
        'Lost',
        'Revision',
      ],
    },
    recoveryLoans: {
      name: 'Recovery Loans',
      columns: [
        'Checkout ID',
        'Item ID',
        'Borrower ID',
        'Quantity',
        'Created At',
        'Outstanding',
        'Lost',
      ],
    },
    recoveryState: {
      name: 'Recovery State',
      columns: [
        'Revision',
        'Next Item ID',
        'Next Borrower ID',
        'Next Location ID',
        'Next Event ID',
      ],
    },
    recoveryBorrowers: {
      name: 'Recovery Borrowers',
      columns: [
        'Borrower ID',
        'Playa Name',
        'Full Name',
        'Phone Number',
        'Camp/Department',
        'Archived',
        'Created At',
      ],
    },
    recoveryEvents: {
      name: 'Recovery Events',
      columns: [
        'Event ID',
        'Kind',
        'Item ID',
        'Borrower ID',
        'Quantity',
        'Related Event ID',
        'Note',
        'Created At',
      ],
    },
    recoveryRadioFleet: {
      name: 'Recovery Radio Fleet',
      columns: ['Count'],
    },
    recoveryRadios: {
      name: 'Recovery Radios',
      columns: ['Number', 'Holder', 'Team', 'Lost'],
    },
    unresolvedDamage: {
      name: 'Unresolved Damage',
      columns: ['Item Name', 'Location', 'Unresolved Damaged Quantity'],
    },
    consumablesUsage: {
      name: 'Consumables Usage',
      columns: [
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
