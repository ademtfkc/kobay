import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { HaritaSemasi } from '../../src/depo/semalar.js';

const eskiHarita = {
  baseUrl: 'http://localhost:3000',
  loggedIn: false,
  exploredAt: '2026-10-01T00:00:00.000Z',
  pages: [
    {
      url: 'http://localhost:3000/',
      title: 'Home',
      headings: ['Welcome'],
      links: ['/about'],
      forms: [{ action: '/login', fields: [{ name: 'email', type: 'email' }] }],
      buttons: ['Go'],
      menu: ['About'],
    },
  ],
};

describe('map schema discovery depth fields', () => {
  it('loads a 0.5.0-shaped map without the new fields', () => {
    const harita = v.parse(HaritaSemasi, eskiHarita);
    expect(harita).toEqual(eskiHarita);
  });

  it('keeps every new optional field when present', () => {
    const dolu = {
      ...eskiHarita,
      seeds: ['http://localhost:3000/hidden'],
      sitemap: { url: 'http://localhost:3000/sitemap.xml', urlCount: 57 },
      sessionSource: 'imported',
      pages: [
        {
          ...eskiHarita.pages[0],
          disclosures: ['Price breakdown'],
          requiresLogin: true,
          redirectedTo: 'http://localhost:3000/login',
          forms: [
            {
              action: '/quote',
              detached: true,
              fields: [
                {
                  name: 'city',
                  type: 'select',
                  options: ['Ankara', 'Izmir'],
                  optionCount: 81,
                },
              ],
            },
          ],
        },
      ],
    };
    expect(v.parse(HaritaSemasi, dolu)).toEqual(dolu);
  });

  it('rejects an unknown sessionSource', () => {
    expect(v.safeParse(HaritaSemasi, { ...eskiHarita, sessionSource: 'x' }).success).toBe(false);
  });
});
