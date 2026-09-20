module.exports = {
  packagerConfig: {
    asar: true,
    name: 'Mapatz Inventory',
    executableName: 'mapatz-inventory',
    appBundleId: 'org.mapatz.inventory',
    osxSign: false,
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'mapatz_inventory',
        authors: 'Mapatz',
        description: 'Offline camp inventory',
      },
    },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
  ],
};
