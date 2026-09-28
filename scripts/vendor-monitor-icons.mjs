import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const source = process.argv[2] || 'lucide';
const icons = require(source);
const packagePath = require.resolve(`${source}/package.json`);
const metadata = JSON.parse(await readFile(packagePath, 'utf8'));
const license = await readFile(resolve(dirname(packagePath), 'LICENSE'), 'utf8');
const names = ['Activity', 'Settings2', 'Save', 'RefreshCw', 'Bell', 'CircleAlert', 'Server', 'Layers', 'Users', 'Search', 'X', 'ChevronDown', 'Check'];
const escapeXml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const symbols = names.map((name) => {
  const id = name.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase();
  const children = icons[name].map(([tag, attributes]) => `<${tag} ${Object.entries(attributes).map(([key, value]) => `${key}="${escapeXml(value)}"`).join(' ')}/>`).join('');
  return `  <symbol id="${id}" viewBox="0 0 24 24">${children}</symbol>`;
});
await writeFile(new URL('../web/vendor/lucide-sprite.svg', import.meta.url), `<!-- Lucide ${metadata.version}; see lucide-LICENSE.txt -->\n<svg xmlns="http://www.w3.org/2000/svg">\n${symbols.join('\n')}\n</svg>\n`);
await writeFile(new URL('../web/vendor/lucide-LICENSE.txt', import.meta.url), license);
console.log(`Vendored ${names.length} Lucide ${metadata.version} icons.`);
