const { buildCss } = require('./scripts/build-css');

module.exports = {
  packagerConfig: {
    executableName: 'Croessant',
    icon: './assets/icon',
    // Solo se empaqueta lo necesario en runtime.
    ignore: [
      /^\/\.github($|\/)/,
      /^\/test($|\/)/,
      /^\/scripts($|\/)/,
      /^\/src\/scss($|\/)/,
      /^\/assets\/screenshots($|\/)/,
      /^\/forge\.config\.js$/,
      /^\/README\.md$/,
    ],
  },
  hooks: {
    // Compila el SCSS antes de `start`, `package`, `make` y `publish`.
    generateAssets: async () => {
      buildCss();
    },
  },
  makers: [
    // `name` fijo para conservar el id de instalación de las versiones anteriores.
    { name: '@electron-forge/maker-squirrel', config: { name: 'Croessant' } },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    // `bin` tiene que coincidir con `executableName`.
    { name: '@electron-forge/maker-deb', config: { options: { bin: 'Croessant' } } },
    { name: '@electron-forge/maker-rpm', config: { options: { bin: 'Croessant' } } },
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: { owner: 'lucaslobasso', name: 'croessant' },
        draft: true,
      },
    },
  ],
};
