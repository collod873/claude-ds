// >>> claude-ds managed >>>
const _tokens = require('./design-system/tokens.json');
const _dsExtend = {
  transitionDuration: Object.fromEntries(
    Object.entries(_tokens.motion?.duration ?? {}).map(([k, v]) => [k, String(v)]),
  ),
  transitionTimingFunction: Object.fromEntries(
    Object.entries(_tokens.motion?.ease ?? {}).map(([k, v]) => [k, String(v)]),
  ),
  boxShadow: Object.fromEntries(
    Object.entries(_tokens.shadow ?? {}).map(([k, v]) => [k, String(v)]),
  ),
  zIndex: Object.fromEntries(
    Object.entries(_tokens.z ?? {}).map(([k, v]) => [k, String(v)]),
  ),
};
const _dsMaskPlugin = ({ addUtilities }) => {
  addUtilities(
    Object.fromEntries(
      Object.entries(_tokens.mask ?? {}).map(([k, v]) => [
        `.mask-${k}`,
        { '-webkit-mask-image': String(v), 'mask-image': String(v) },
      ]),
    ),
  );
};
// <<< claude-ds managed <<<

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [],
  theme: {
    extend: {
      ..._dsExtend,
    },
  },
  plugins: [_dsMaskPlugin],
};
