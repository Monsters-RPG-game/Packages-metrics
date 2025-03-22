import { describe, expect, it } from '@jest/globals';

describe('Get detailed', () => {
  describe('Should throw', () => {
    describe('No data passed', () => {
      it(`Get data`, async () => {
      expect(2+2).toEqual(4)
      });
    });

    describe('Incorrect data', () => {
      it(`Get data`, async () => {
      expect(2+2).toEqual(4)
      });
    });
  });

  describe('Should pass', () => {
      it(`Get data`, async () => {
      expect(2+2).toEqual(4)
      });
  });
});
