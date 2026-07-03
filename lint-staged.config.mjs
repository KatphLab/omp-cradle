export default {
  '*.{ts,mts}': ['eslint --fix', 'prettier --write'],
  '*.{json,md,css,yml,yaml,mjs,js}': ['prettier --write'],
  'package.json': ['prettier --write'],
}
