import defaultConfig from './jest.config.default.mjs';

const config = {
  ...defaultConfig,
  roots: ['./__tests__/unit'],
};

export default config;
