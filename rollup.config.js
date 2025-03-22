import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json'
import resolve from '@rollup/plugin-node-resolve';

export default {
  input: 'lib/index.js',
  output: {
    file: 'lib/commonIndex.cjs',
    format: 'cjs'
  },
  plugins: [
    resolve({ preferBuiltins: true }),
    commonjs(),
    json()
  ]
};

