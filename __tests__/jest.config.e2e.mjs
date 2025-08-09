import defaultConfig from './jest.config.default.mjs';

const config = {
  ...defaultConfig,
  roots: ['./__tests__/e2e'],
  setupFilesAfterEnv: ['./__tests__/utils/setup.ts'],
};

export default config;
