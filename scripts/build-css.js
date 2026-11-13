// Compila src/scss/main.scss -> src/css/main.css (lo usan `npm run css` y Electron Forge).
const fs = require('node:fs');
const path = require('node:path');
const sass = require('sass');

const root = path.join(__dirname, '..');

function buildCss() {
  const result = sass.compile(path.join(root, 'src/scss/main.scss'), {
    style: 'compressed',
    // Bulma 0.9 usa sintaxis de Sass ya deprecada; no es código nuestro.
    quietDeps: true,
    silenceDeprecations: ['import', 'global-builtin', 'color-functions', 'slash-div', 'if-function'],
    logger: {
      warn(message, { span }) {
        const from = span && span.url ? span.url.pathname : '';
        if (!from.includes('/node_modules/')) console.warn(`Sass: ${message} (${from})`);
      },
    },
  });

  fs.mkdirSync(path.join(root, 'src/css'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/css/main.css'), result.css);
}

if (require.main === module) {
  buildCss();
}

module.exports = { buildCss };
